import { describe, expect, test, vi } from 'vitest';

import {
  PUBLIC_BODY_LIMIT,
  assertMcpAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertPublicAccess,
  bearerAuthenticator,
  createBearerAuth,
  protectedResourceMetadataAnswer,
  readJsonBody,
  resourceMetadataUrlFor,
  verifyClerkOAuthToken,
} from './bearer-auth';
import { type PublicAccess, McpAuthError, McpTokenVerificationError } from './server';
import { FAKE_PK, clerkAuthenticated, expiresAt } from './test/mcp-harness';

const authInfo = {
  token: 't',
  clientId: 'client-1',
  scopes: ['profile'],
  expiresAt,
};

type Authenticate = ReturnType<typeof bearerAuthenticator>;

// The options `bearerAuthenticator` reads and the request fields, side by side
function authenticate(
  overrides: Partial<Parameters<typeof bearerAuthenticator>[0] & Parameters<Authenticate>[0]> = {},
): ReturnType<Authenticate> {
  const { resourceUrl, requiredScopes, challengeScopes, publicAccess, ...request } = overrides;
  return bearerAuthenticator({ resourceUrl, requiredScopes, challengeScopes, publicAccess })({
    authorization: 'Bearer t',
    requestUrl: 'https://mcp.example.com/mcp',
    verifyToken: async () => authInfo,
    ...request,
  });
}

describe('resourceUrl validation', () => {
  test.each(['https://mcp.example.com/mcp#tools', 'https://mcp.example.com/mcp#'])(
    'rejects %s, because a resource identifier has no fragment',
    (resourceUrl) => {
      expect(() => assertMcpAuthOptions('mcpAuth', { resourceUrl })).toThrow(
        'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL without credentials or a fragment',
      );
    },
  );

  test.each(['/mcp', 'mailto:foo@example.com', 'https://user:pass@mcp.example.com/mcp'])(
    'rejects %s, alone or in a list',
    (url) => {
      const message =
        'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL without credentials';
      expect(() => assertMcpAuthOptions('mcpAuth', { resourceUrl: url })).toThrow(message);
      expect(() =>
        assertMcpAuthOptions('mcpAuth', { resourceUrl: ['https://mcp.example.com/mcp', url] }),
      ).toThrow(message);
    },
  );

  test.each([
    [{ resourceUrl: [] }, 'mcpAuth resourceUrl must be a URL or a non-empty list of URLs'],
    [
      { resourceUrl: ['https://mcp.example.com/a', 'https://mcp.example.com/b'] },
      'mcpAuth resourceUrl lists more than one URL for https://mcp.example.com',
    ],
    [{ requiredScopes: ['a b'] }, 'mcpAuth requiredScopes must contain only scope tokens'],
    [{ challengeScopes: [''] }, 'mcpAuth challengeScopes must contain only scope tokens'],
  ])('rejects %j', (options, message) => {
    expect(() => assertMcpAuthOptions('mcpAuth', options)).toThrow(`Clerk error: ${message}`);
  });

  test.each([
    'https://mcp.example.com',
    'https://mcp.example.com/mcp?tenant=a',
    'http://localhost:3000/mcp',
  ])('accepts %s', (resourceUrl) => {
    expect(() => assertMcpAuthOptions('mcpAuth', { resourceUrl })).not.toThrow();
  });
});

describe('resourceMetadataUrlFor', () => {
  test.each([
    [
      'https://mcp.example.com/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    ],
    ['https://mcp.example.com', 'https://mcp.example.com/.well-known/oauth-protected-resource'],
    ['https://mcp.example.com/', 'https://mcp.example.com/.well-known/oauth-protected-resource'],
    [
      'https://mcp.example.com/mcp?tenant=a',
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp?tenant=a',
    ],
  ])('puts the well-known path between the host and the path and query of %s', (url, expected) => {
    expect(resourceMetadataUrlFor(url)).toBe(expected);
  });
});

describe('bearerAuthenticator', () => {
  test('derives the metadata URL from the request path, without its query or a trailing slash at the root', async () => {
    const withQuery = await authenticate({
      authorization: undefined,
      requestUrl: 'https://mcp.example.com/mcp?session=1',
    });
    const root = await authenticate({
      authorization: undefined,
      requestUrl: 'https://mcp.example.com/',
    });

    expect(withQuery).toMatchObject({
      headers: {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
      },
    });
    expect(root).toMatchObject({
      headers: {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      },
    });
  });

  test('lists requiredScopes then challengeScopes in the 401 challenge, each once', async () => {
    const result = await authenticate({
      authorization: undefined,
      requiredScopes: ['profile', 'email'],
      challengeScopes: ['email', 'projects:read'],
    });

    expect(result).toMatchObject({
      status: 401,
      headers: {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="profile email projects:read"',
      },
    });
  });

  test('answers an unlisted origin with a 421 before reading the token', async () => {
    const verifyToken = vi.fn();

    const result = await authenticate({
      requestUrl: 'https://other.example.com/mcp',
      resourceUrl: ['https://mcp.example.com/mcp'],
      verifyToken,
    });

    expect(result).toEqual({
      ok: false,
      failure: { reason: 'misdirected_request' },
      status: 421,
      headers: {},
      body: { error: 'misdirected_request' },
    });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('rejects a token whose verifier throws an McpTokenVerificationError, with it as the cause', async () => {
    const cause = new McpTokenVerificationError('token-revoked', 'The token was revoked');

    const result = await authenticate({
      verifyToken: async () => {
        throw cause;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      failure: { reason: 'invalid_token', cause },
    });
  });

  test('wraps any other verifier error once, and passes an McpAuthError through', async () => {
    const cause = new Error('network down');
    const thrown = new McpAuthError(cause);

    const wrapped = await authenticate({
      verifyToken: async () => {
        throw cause;
      },
    }).catch((error: unknown) => error);
    const passedThrough = await authenticate({
      verifyToken: async () => {
        throw thrown;
      },
    }).catch((error: unknown) => error);

    expect(wrapped).toBeInstanceOf(McpAuthError);
    expect(wrapped).toMatchObject({ cause });
    // The verifier can be the app's own `verifyToken`, so the message must not blame Clerk; the `cause` says who failed
    expect((wrapped as McpAuthError).message).toBe('MCP access token verification failed');
    expect(passedThrough).toBe(thrown);
  });

  const now = Math.floor(Date.now() / 1000);

  test('accepts a token whose expiresAt has not passed', async () => {
    await expect(
      authenticate({ verifyToken: async () => ({ ...authInfo, expiresAt: now + 60 }) }),
    ).resolves.toMatchObject({ ok: true });
  });

  // Passed, or outside the Date range. One that is not a finite number is `token-claims-missing` instead.
  test.each([
    [now - 1, 'token-expired'],
    [-8_640_000_000_001, 'token-expired'],
    [-1e300, 'token-expired'],
    [-Number.MAX_VALUE, 'token-expired'],
    [Number.NaN, 'token-claims-missing'],
    [Number.POSITIVE_INFINITY, 'token-claims-missing'],
  ])('rejects a token whose expiresAt is %d with invalid_token (%s)', async (expiresAt, code) => {
    const result = await authenticate({ verifyToken: async () => ({ ...authInfo, expiresAt }) });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      headers: {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
      },
      failure: { reason: 'invalid_token', cause: { code } },
    });
  });

  test('rejects a token its verifier reports for another resource, as MCP SDK 2 does', async () => {
    const result = await authenticate({
      resourceUrl: 'https://mcp.example.com/mcp',
      verifyToken: async () => ({
        ...authInfo,
        resource: new URL('https://other.example.com/mcp'),
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      headers: {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
      },
      failure: {
        reason: 'invalid_token',
        cause: {
          code: 'resource-mismatch',
          message:
            'The token was issued for https://other.example.com/mcp, not https://mcp.example.com/mcp',
        },
      },
    });
  });

  test('checks the reported resource against the listed URL for the request origin', async () => {
    const resourceUrl = ['https://mcp.example.com/mcp', 'https://mcp.example.org/mcp'];
    const verifyToken = async () => ({
      ...authInfo,
      resource: new URL('https://mcp.example.com/mcp'),
    });

    const sameOrigin = await authenticate({ resourceUrl, verifyToken });
    const otherListedOrigin = await authenticate({
      requestUrl: 'https://mcp.example.org/mcp',
      resourceUrl,
      verifyToken,
    });

    expect(sameOrigin).toMatchObject({ ok: true });
    expect(otherListedOrigin).toMatchObject({
      ok: false,
      status: 401,
      failure: { reason: 'invalid_token', cause: { code: 'resource-mismatch' } },
    });
  });

  test.each([
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp/', 'https://mcp.example.com/mcp/'],
    ['https://mcp.example.com/mcp?tenant=1', 'https://mcp.example.com/mcp?tenant=1'],
    ['https://MCP.example.com:443/mcp', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com', 'https://mcp.example.com/'],
    ['https://mcp.example.com/', 'https://mcp.example.com'],
  ])('accepts a token for %s whose verifier reports %s', async (resourceUrl, resource) => {
    const result = await authenticate({
      requestUrl: 'https://mcp.example.com/mcp',
      resourceUrl,
      verifyToken: async () => ({ ...authInfo, resource: new URL(resource) }),
    });

    expect(result).toMatchObject({ ok: true });
  });

  test.each([
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp/'],
    ['https://mcp.example.com/mcp/', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp#section'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp#'],
    ['https://mcp.example.com', 'https://mcp.example.com/#section'],
    ['https://mcp.example.com', 'https://mcp.example.com/#'],
    ['https://mcp.example.com/mcp?tenant=1', 'https://mcp.example.com/mcp?tenant=1/'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/'],
    ['https://mcp.example.com/mcp', 'http://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp?tenant=1'],
  ])('rejects a token for %s whose verifier reports %s', async (resourceUrl, resource) => {
    const result = await authenticate({
      resourceUrl,
      verifyToken: async () => ({ ...authInfo, resource: new URL(resource) }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      failure: { reason: 'invalid_token', cause: { code: 'resource-mismatch' } },
    });
  });

  test('leaves the resource unchecked when the verifier reports none, or resourceUrl is not set', async () => {
    const withoutResource = await authenticate({ resourceUrl: 'https://mcp.example.com/mcp' });
    const withoutResourceUrl = await authenticate({
      verifyToken: async () => ({ ...authInfo, resource: new URL('https://internal:3000/mcp') }),
    });

    expect(withoutResource).toMatchObject({ ok: true });
    expect(withoutResourceUrl).toMatchObject({ ok: true });
  });
});

describe('McpAuthError', () => {
  test.each([429, 500, 503, 599])('keeps a %i status from the cause', (status) => {
    expect(new McpAuthError(Object.assign(new Error('unavailable'), { status })).status).toBe(
      status,
    );
  });

  test.each([400, 401, 403, 428, 600, '503', 503.5, Number.NaN])(
    'drops a %j status from the cause',
    (status) => {
      expect(
        new McpAuthError(Object.assign(new Error('rejected'), { status })).status,
      ).toBeUndefined();
    },
  );
});

describe('public identity tool warning', () => {
  // Like the prebuilt tool's step-up warning, this is module-level, even when middleware is rebuilt per request.
  async function freshAuth() {
    vi.resetModules();
    return (await import('./bearer-auth')).createBearerAuth;
  }

  test.each(['mcpAuth', 'withClerkMcpAuth'])(
    '%s warns at startup once across middleware instances, without changing public access',
    async (caller) => {
      const create = await freshAuth();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const verifyToken = vi.fn(async () => authInfo);
      const defaultClient = vi.fn();
      const options = {
        verifyToken,
        publicAccess: {
          tools: ['create_browser_session', 'create_browser_session', 'search_docs'],
        },
      };
      try {
        const first = create(caller, options, defaultClient, 'Clerk');
        // It is a setup warning, not one deferred until a request arrives.
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          'Clerk warning: create_browser_session requires a Clerk identity but is listed in publicAccess.tools. Calls without a token will get not_authenticated instead of a 401 challenge, so the client will not start sign-in. Remove create_browser_session from publicAccess.tools.',
        );
        const second = create(caller, options, defaultClient, 'Clerk');
        for (const authenticate of [first, second, second]) {
          await expect(
            authenticate(undefined, {
              authorization: undefined,
              requestUrl: 'https://mcp.example.com/mcp',
              method: 'POST',
              body: async () => ({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'create_browser_session' },
              }),
            }),
          ).resolves.toEqual({ ok: true, authInfo: undefined });
        }
        expect(warn).toHaveBeenCalledOnce();
        expect(verifyToken).not.toHaveBeenCalled();
        expect(defaultClient).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  test.each([
    undefined,
    {},
    { methods: true },
    { tools: [] },
    { tools: ['submit_feedback', 'search_docs', 'create_browser_session_custom'] },
  ])('does not warn for publicAccess %j', async (publicAccess) => {
    const create = await freshAuth();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const options = { verifyToken: async () => authInfo, publicAccess };
      create('mcpAuth', options, vi.fn(), 'Clerk');
      expect(warn).not.toHaveBeenCalled();
      // A safe configuration must not consume the one-time warning for a later unsafe one.
      create(
        'mcpAuth',
        { ...options, publicAccess: { tools: ['create_browser_session'] } },
        vi.fn(),
        'Clerk',
      );
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Clerk audience rejection warning', () => {
  test.each([
    'OAuth audience mismatch. Verification expected audience ["expected"], but incoming token has aud "private-audience".',
    'Invalid OAuth audience claim (aud) undefined. Expected a non-empty string or a non-empty array of non-empty strings.',
    'Invalid JWT audience claim (aud) "private-audience".',
    'Invalid JWT audience claim array (aud) ["private-audience"].',
  ])('warns once per auth instance for %s without changing the 401', async (message) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = {
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: false,
          reason: 'token-verification-failed',
          message,
        }),
      };
      const resourceUrl = 'https://mcp.example.com/mcp';
      const make = () =>
        createBearerAuth(
          'mcpAuth',
          { resourceUrl, clerkClient: client },
          async () => client,
          'Clerk',
        );
      const authenticate = make();
      const input = { authorization: 'Bearer private-token', requestUrl: resourceUrl };
      const first = await authenticate(undefined, input);
      const second = await authenticate(undefined, input);

      expect(first).toMatchObject({
        ok: false,
        status: 401,
        body: { error: 'Unauthorized' },
        headers: {
          'WWW-Authenticate':
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
        },
        failure: { reason: 'invalid_token', cause: { code: 'token-verification-failed', message } },
      });
      expect(second).toEqual(first);
      expect(warn).toHaveBeenCalledOnce();
      const warning = warn.mock.calls[0]?.[0];
      expect(warning).toMatch(/^Clerk warning:/);
      for (const text of [
        'aud',
        'Clerk Dashboard',
        'first MCP server',
        'resource',
        '@clerk/backend',
        '3.19.0',
      ]) {
        expect(warning).toContain(text);
      }
      expect(warning).not.toContain('private-token');
      expect(warning).not.toContain('private-audience');

      await make()(undefined, input);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('does not warn about an unrelated rejection or a custom verifier', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const resourceUrl = 'https://mcp.example.com/mcp';
      const client = {
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: false,
          reason: 'token-verification-failed',
          message: 'JWT signature is invalid.',
        }),
      };
      const input = { authorization: 'Bearer t', requestUrl: resourceUrl };
      await createBearerAuth(
        'mcpAuth',
        { resourceUrl, clerkClient: client },
        async () => client,
        'Clerk',
      )(undefined, input);
      await createBearerAuth(
        'mcpAuth',
        {
          resourceUrl,
          verifyToken: () => {
            throw new McpTokenVerificationError(
              'token-verification-failed',
              'OAuth audience mismatch.',
            );
          },
        },
        async () => client,
        'Clerk',
      )(undefined, input);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('verifyClerkOAuthToken', () => {
  const authenticated = clerkAuthenticated(['profile']);

  test('checks the audience against the URL as written when it is already normalized', async () => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated);

    await verifyClerkOAuthToken({ authenticateRequest }, 't', 'https://mcp.example.com/mcp');

    expect(authenticateRequest.mock.calls[0]?.[1]).toEqual({
      acceptsToken: 'oauth_token',
      audience: 'https://mcp.example.com/mcp',
    });
  });

  test.each([
    ['https://mcp.example.com', ['https://mcp.example.com/']],
    // Clerk keeps the default port when it lowercases the scheme and host
    [
      'https://MCP.Example.com:443/mcp',
      ['https://mcp.example.com/mcp', 'https://mcp.example.com:443/mcp'],
    ],
    // The root's protected resource metadata describes the bare origin, so a client can send that form back
    ['https://mcp.example.com/', ['https://mcp.example.com']],
  ])('also accepts the other forms of %s as the audience', async (resourceUrl, others) => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated);

    await verifyClerkOAuthToken({ authenticateRequest }, 't', resourceUrl);

    expect(authenticateRequest.mock.calls[0]?.[1]).toEqual({
      acceptsToken: 'oauth_token',
      audience: [resourceUrl, ...others],
    });
  });

  test('accepts the empty id Clerk gives a JWT access token without a jti', async () => {
    const auth = { ...authenticated.toAuth(), id: '' };
    const authenticateRequest = vi
      .fn()
      .mockResolvedValue({ isAuthenticated: true, toAuth: () => auth });

    const authInfo = await verifyClerkOAuthToken(
      { authenticateRequest },
      't',
      'https://mcp.example.com/mcp',
    );

    expect(authInfo.extra.auth?.id).toBe('');
    expect(authInfo.extra.auth).toBe(auth);
  });

  test.each([
    ['no getToken', { ...authenticated.toAuth(), getToken: undefined }],
    [
      'no user, client, or scopes',
      { isAuthenticated: true, tokenType: 'oauth_token', clientId: 'client-1' },
    ],
  ])('rejects a token whose auth object has %s, with a cause', async (_case, auth) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const authenticateRequest = vi
      .fn()
      .mockResolvedValue({ isAuthenticated: true, toAuth: () => auth });

    const error = await verifyClerkOAuthToken(
      { authenticateRequest },
      't',
      'https://mcp.example.com/mcp',
    ).catch((thrown: unknown) => thrown);
    consoleError.mockRestore();

    expect(error).toBeInstanceOf(McpTokenVerificationError);
    expect(error).toMatchObject({ code: 'token-claims-missing' });
  });
});

const metadataOrigin = 'https://mcp.example.com';
const metadataUrl = `${metadataOrigin}/.well-known/oauth-protected-resource/mcp`;

describe('protectedResourceMetadataAnswer', () => {
  const metadata = (options: Parameters<typeof protectedResourceMetadataAnswer>[0]) =>
    protectedResourceMetadataAnswer(
      { resourceUrl: 'https://public.example.com/mcp', ...options },
      { publishableKey: FAKE_PK, url: metadataUrl },
    ).body as Record<string, unknown>;

  // RFC 9728 section 2: `scopes_supported` lists the scope values used to request access to this resource
  test('lists requiredScopes then challengeScopes, each once, as scopes_supported', () => {
    expect(
      metadata({
        requiredScopes: ['profile', 'email'],
        challengeScopes: ['email', 'projects:read'],
      })?.scopes_supported,
    ).toEqual(['profile', 'email', 'projects:read']);
  });

  // A key set to `undefined`, as `{ scopes_supported: config.scopes }` gives without one, is not a list to use
  test('lists requiredScopes then challengeScopes when properties sets scopes_supported to undefined', () => {
    expect(
      metadata({
        requiredScopes: ['profile'],
        challengeScopes: ['email'],
        properties: { scopes_supported: undefined, resource_name: 'MCP' },
      }),
    ).toMatchObject({ scopes_supported: ['profile', 'email'], resource_name: 'MCP' });
  });

  test('leaves scopes_supported out without scopes', () => {
    expect(metadata({})).not.toHaveProperty('scopes_supported');
  });

  // RFC 9728 section 2 lets a resource advertise scopes it does not require
  test('uses an explicit scopes_supported that lists every scope as given', () => {
    expect(
      metadata({
        requiredScopes: ['profile'],
        challengeScopes: ['email'],
        properties: { scopes_supported: ['email', 'admin', 'profile'] },
      })?.scopes_supported,
    ).toEqual(['email', 'admin', 'profile']);
  });
});

describe('assertProtectedResourceMetadataOptions', () => {
  test.each([
    ['additional metadata', { scopes_supported: ['email'] }],
    ['a resource', { resource: 'https://mcp.example.com/mcp' }],
    [
      'additional metadata beside resourceUrl',
      { resourceUrl: metadataOrigin, resource_name: 'MCP' },
    ],
  ])('throws when given %s in place of options', (_case, options) => {
    expect(() => assertProtectedResourceMetadataOptions(options)).toThrow(
      'Clerk error: protectedResourceMetadataHandler takes an options object with resourceUrl and properties',
    );
  });

  // RFC 9728 section 3.3: the `resource` must be the URL the client derived the metadata URL from
  test.each([
    ['without resourceUrl', {}],
    ['beside resourceUrl', { resourceUrl: 'https://mcp.example.com/mcp' }],
  ])('throws when properties sets resource %s', (_case, options) => {
    expect(() =>
      assertProtectedResourceMetadataOptions({
        ...options,
        properties: { resource: 'https://mcp.example.com/mcp' },
      }),
    ).toThrow(
      'Clerk error: protectedResourceMetadataHandler properties cannot set resource: it must be the resourceUrl the metadata describes (RFC 9728 section 3.3)',
    );
  });

  test.each([
    ['a required scope', { requiredScopes: ['profile', 'email'] }, 'email'],
    ['a challenge scope', { challengeScopes: ['projects:read'] }, 'projects:read'],
  ])('throws when scopes_supported leaves out %s', (_case, scopes, missing) => {
    expect(() =>
      assertProtectedResourceMetadataOptions({
        resourceUrl: metadataOrigin,
        ...scopes,
        properties: { scopes_supported: ['profile'] },
      }),
    ).toThrow(
      `Clerk error: protectedResourceMetadataHandler properties.scopes_supported leaves out ${missing},`,
    );
  });

  test.each([
    ['a string', 'email', {}],
    ['a string beside requiredScopes', 'email', { requiredScopes: ['email'] }],
    ['a list with an entry that is not a string', ['email', 1], {}],
    [
      'a list with an entry that is not a string beside requiredScopes',
      [1],
      { requiredScopes: ['email'] },
    ],
    ['null', null, {}],
  ])('throws when scopes_supported is %s', (_case, scopes_supported, scopes) => {
    expect(() =>
      assertProtectedResourceMetadataOptions({
        resourceUrl: metadataOrigin,
        ...scopes,
        properties: { scopes_supported },
      }),
    ).toThrow(
      'Clerk error: protectedResourceMetadataHandler properties.scopes_supported must be an array of strings',
    );
  });
});

describe('publicAccess', () => {
  const rpc = (method: string, params?: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(params && { params }),
  });

  function withoutToken(
    publicAccess: PublicAccess | undefined,
    body: unknown,
    overrides: Parameters<typeof authenticate>[0] = {},
  ) {
    return authenticate({
      authorization: undefined,
      publicAccess,
      method: 'POST',
      body: () => body,
      ...overrides,
    });
  }

  const open = { ok: true, authInfo: undefined };
  const challenged = { ok: false, status: 401, failure: { reason: 'missing_token' } };

  test('without it, a request without a token gets the 401 and its body is never read', async () => {
    const body = vi.fn(() => rpc('initialize'));
    await expect(withoutToken(undefined, undefined, { body })).resolves.toMatchObject(challenged);
    expect(body).not.toHaveBeenCalled();
  });

  type Case = [PublicAccess, unknown];
  const all = { methods: true, tools: ['search_docs'], resources: true, prompts: true };
  const methodList: PublicAccess = { methods: ['initialize', 'tools/list'] };
  const tools: PublicAccess = { tools: ['search_docs'] };
  const resources: PublicAccess = { resources: ['docs://index'] };
  const prompts: PublicAccess = { prompts: ['summarize'] };
  const listed: PublicAccess = { methods: true, resources: ['docs://index', 'docs://faq'] };
  const methodsAndResources: PublicAccess = { methods: true, resources: true };
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const call = (name: unknown) => rpc('tools/call', { name });
  const read = (uri: unknown) => rpc('resources/read', { uri });
  const get = (name: unknown) => rpc('prompts/get', { name });
  const listen = (notifications: unknown) => rpc('subscriptions/listen', { notifications });

  test.each<Case>([
    ...[
      'initialize',
      'notifications/initialized',
      'server/discover',
      'ping',
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'prompts/list',
    ].map((method): Case => [{ methods: true }, rpc(method)]),
    [methodList, rpc('initialize')],
    [methodList, rpc('tools/list')],
    // notifications/initialized follows initialize
    [{ methods: ['initialize'] }, initialized],
    [tools, rpc('tools/call', { name: 'search_docs', arguments: {} })],
    [{ resources: true }, read('docs://index')],
    [{ prompts: true }, get('summarize')],
    [resources, read('docs://index')],
    [prompts, get('summarize')],
    // A batch whose every message is open
    [{ methods: true, tools: ['search_docs'] }, [rpc('tools/list'), call('search_docs')]],
    [listed, listen({ resourceSubscriptions: ['docs://index', 'docs://faq'] })],
    [listed, listen({ resourceSubscriptions: [] })],
    [methodsAndResources, listen({ resourceSubscriptions: ['x://y'] })],
  ])('%j opens %j', async (publicAccess, body) => {
    await expect(withoutToken(publicAccess, body)).resolves.toEqual(open);
  });

  test.each<Case>([
    [methodList, rpc('resources/list')],
    [methodList, rpc('ping')],
    [{ methods: ['server/discover', 'tools/list'] }, initialized],
    // `methods` opens no call
    [{ methods: true }, call('search_docs')],
    [{ methods: true }, read('docs://index')],
    [{ methods: true }, get('summarize')],
    // A tools/call for a tool not named, with a name inherited from Object.prototype or not a string, or without one
    [tools, call('whoami')],
    [tools, call('constructor')],
    [tools, call('__proto__')],
    [tools, call(['search_docs'])],
    [tools, rpc('tools/call', {})],
    [tools, rpc('tools/call')],
    [{ resources: true }, get('summarize')],
    // The list is a protocol method, which only `methods` opens
    [{ resources: true }, rpc('resources/list')],
    // A resources list opens a URI it names, exactly
    ...['docs://private', 'docs://index/', 'DOCS://index', ['docs://index']].map((uri): Case => [
      resources,
      read(uri),
    ]),
    [resources, rpc('resources/read', { name: 'docs://index' })],
    [resources, rpc('resources/read')],
    [{ resources: [] }, read('docs://index')],
    [{ resources: false }, read('docs://index')],
    [prompts, get('draft_reply')],
    [prompts, get('constructor')],
    [prompts, rpc('prompts/get', {})],
    [prompts, rpc('prompts/get')],
    // A list for one kind of call opens nothing of another kind
    [prompts, call('summarize')],
    [prompts, read('summarize')],
    // One protected message closes a batch, and an empty batch has nothing open
    [{ methods: true, tools: ['search_docs'] }, [call('search_docs'), call('whoami')]],
    [{ methods: true, tools: ['search_docs'] }, []],
    // A body that could not be read, null, a string, a response, an unknown notification or method, or a method that
    // is not a string
    [all, undefined],
    [all, null],
    [all, 'initialize'],
    [all, { jsonrpc: '2.0', id: 1, result: {} }],
    [all, { jsonrpc: '2.0', method: 'notifications/custom' }],
    [all, { jsonrpc: '2.0', id: 1, method: 'tasks/get' }],
    [all, { jsonrpc: '2.0', id: 1, method: ['initialize'] }],
    // Tasks, even when a public tool could have started the task
    ...['tasks/get', 'tasks/result', 'tasks/cancel', 'tasks/list'].map((method): Case => [
      all,
      rpc(method, { taskId: 'task_1' }),
    ]),
    // A subscriptions/listen to a resource that is not open, or whose notifications are not an object
    [listed, listen({ resourceSubscriptions: ['docs://index', 'docs://private'] })],
    [listed, listen({ resourceSubscriptions: ['DOCS://index'] })],
    [listed, listen({ resourceSubscriptions: 'docs://index' })],
    [listed, listen({ resourceSubscriptions: [['docs://index']] })],
    [{ methods: true }, listen({ resourceSubscriptions: ['docs://index'] })],
    [methodsAndResources, rpc('subscriptions/listen')],
    [methodsAndResources, rpc('subscriptions/listen', {})],
    [methodsAndResources, listen(true)],
    [methodsAndResources, listen(null)],
    [methodsAndResources, listen([])],
  ])('%j challenges %j', async (publicAccess, body) => {
    await expect(withoutToken(publicAccess, body)).resolves.toMatchObject(challenged);
  });

  const openNotifications = [
    {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1, reason: 'timeout' },
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'a', progress: 1 },
    },
    { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
  ];

  test.each([
    { methods: true },
    { methods: ['ping'] },
    { tools: ['search_docs'] },
    { resources: ['docs://index'] },
    { prompts: true },
  ] as const)(
    'opens the cancelled, progress, and roots notifications when %j opens something',
    async (publicAccess) => {
      for (const notification of openNotifications) {
        await expect(withoutToken(publicAccess, notification)).resolves.toEqual(open);
      }
      await expect(withoutToken(publicAccess, openNotifications)).resolves.toEqual(open);
    },
  );

  test.each([
    {},
    { methods: false },
    { methods: [], tools: [], resources: [], prompts: false },
  ] as const)(
    'keeps the cancelled, progress, and roots notifications closed when %j opens nothing',
    async (publicAccess) => {
      for (const notification of openNotifications) {
        await expect(withoutToken(publicAccess, notification)).resolves.toMatchObject(challenged);
      }
    },
  );

  const handshakeOpen: PublicAccess[] = [
    { methods: true },
    { methods: ['initialize'] },
    { methods: ['server/discover'] },
  ];
  const handshakeClosed: PublicAccess[] = [
    { methods: ['ping', 'tools/list'] },
    { tools: ['search_docs'] },
    { resources: true },
    {},
  ];

  test.each(handshakeOpen)(
    'answers a GET without a token with a 405 when %j opens the handshake',
    async (publicAccess) => {
      const result = await withoutToken(publicAccess, undefined, { method: 'GET' });
      expect(result).toMatchObject({
        ok: false,
        failure: undefined,
        status: 405,
        headers: { Allow: 'POST' },
      });
    },
  );

  test.each(handshakeOpen)(
    'opens a subscriptions/listen without resource subscriptions when %j opens the handshake',
    async (publicAccess) => {
      await expect(
        withoutToken(publicAccess, listen({ toolsListChanged: true, promptsListChanged: true })),
      ).resolves.toEqual(open);
      await expect(withoutToken(publicAccess, listen({}))).resolves.toEqual(open);
    },
  );

  test.each(handshakeClosed)(
    'answers a GET with the 401 and keeps a subscriptions/listen closed when %j leaves the handshake closed',
    async (publicAccess) => {
      await expect(withoutToken(publicAccess, undefined, { method: 'GET' })).resolves.toMatchObject(
        challenged,
      );
      await expect(
        withoutToken(publicAccess, listen({ toolsListChanged: true })),
      ).resolves.toMatchObject(challenged);
    },
  );

  test('answers a DELETE without a token with the 401, and reads a body only for a POST', async () => {
    const body = vi.fn(() => rpc('initialize'));
    await expect(
      withoutToken({ methods: true }, undefined, { method: 'DELETE', body }),
    ).resolves.toMatchObject(challenged);
    await expect(
      withoutToken({ methods: true }, undefined, { method: undefined, body }),
    ).resolves.toMatchObject(challenged);
    expect(body).not.toHaveBeenCalled();
    await expect(
      withoutToken({ methods: true }, undefined, { method: 'post', body }),
    ).resolves.toEqual(open);
    expect(body).toHaveBeenCalledTimes(1);
  });

  test('verifies a request that carries a token as usual, without reading its body', async () => {
    const body = vi.fn(() => rpc('initialize'));
    const publicAccess: PublicAccess = { methods: true };
    await expect(authenticate({ publicAccess, method: 'POST', body })).resolves.toMatchObject({
      ok: true,
      authInfo: { clientId: 'client-1' },
    });
    await expect(
      authenticate({ publicAccess, method: 'POST', body, verifyToken: async () => undefined }),
    ).resolves.toMatchObject({ ok: false, status: 401, failure: { reason: 'invalid_token' } });
    await expect(
      authenticate({ publicAccess, method: 'POST', body, authorization: 'Basic dXNlcjpwYXNz' }),
    ).resolves.toMatchObject({ ok: false, status: 401, failure: { reason: 'malformed_token' } });
    expect(body).not.toHaveBeenCalled();
  });

  test('answers an unlisted origin with the 421 before the public check', async () => {
    await expect(
      withoutToken({ methods: true }, rpc('initialize'), {
        resourceUrl: ['https://mcp.example.com/mcp'],
        requestUrl: 'https://other.example.com/mcp',
      }),
    ).resolves.toMatchObject({ ok: false, status: 421 });
  });
});

describe('assertPublicAccess', () => {
  test.each([
    undefined,
    {},
    { methods: true },
    { methods: false },
    { methods: ['initialize', 'server/discover', 'ping', 'tools/list'] },
    { methods: true, tools: ['search_docs'], resources: true, prompts: false },
    { resources: ['docs://index'], prompts: ['summarize'] },
    { resources: [], prompts: [] },
    { methods: undefined, tools: undefined, resources: undefined, prompts: undefined },
  ])('accepts %j', (publicAccess) => {
    expect(() => assertPublicAccess('mcpAuth', publicAccess)).not.toThrow();
  });

  test.each([
    [true, 'Clerk error: mcpAuth publicAccess must be an object'],
    [['initialize'], 'Clerk error: mcpAuth publicAccess must be an object'],
    [null, 'Clerk error: mcpAuth publicAccess must be an object'],
    [
      { method: true },
      'Clerk error: mcpAuth publicAccess has no method option. It takes any of methods, tools, resources, prompts',
    ],
    [{ methods: 'initialize' }, 'Clerk error: mcpAuth publicAccess.methods must be true or a list'],
    [
      { methods: ['tools/call'] },
      'Clerk error: mcpAuth publicAccess.methods cannot list tools/call. To open it without a token, name the tools in publicAccess.tools',
    ],
    [
      { methods: ['resources/read'] },
      'Clerk error: mcpAuth publicAccess.methods cannot list resources/read. To open it without a token, set publicAccess.resources to true',
    ],
    [
      { methods: ['prompts/get'] },
      'Clerk error: mcpAuth publicAccess.methods cannot list prompts/get. To open it without a token, set publicAccess.prompts to true',
    ],
    [
      { methods: ['notifications/initialized'] },
      'Clerk error: mcpAuth publicAccess.methods cannot list "notifications/initialized". It takes true or any of initialize, server/discover, ping, tools/list, resources/list, resources/templates/list, prompts/list',
    ],
    [{ methods: [1] }, 'Clerk error: mcpAuth publicAccess.methods cannot list 1'],
    [{ tools: true }, 'Clerk error: mcpAuth publicAccess.tools must be a list of tool names'],
    [
      { tools: 'search_docs' },
      'Clerk error: mcpAuth publicAccess.tools must be a list of tool names',
    ],
    [{ tools: [''] }, 'Clerk error: mcpAuth publicAccess.tools must be a list of tool names'],
    [
      { resources: 'all' },
      "Clerk error: mcpAuth publicAccess.resources must be true, false, or a list of resource URIs, such as ['docs://index']",
    ],
    [
      { resources: [''] },
      'Clerk error: mcpAuth publicAccess.resources must be true, false, or a list',
    ],
    [
      { prompts: 1 },
      "Clerk error: mcpAuth publicAccess.prompts must be true, false, or a list of prompt names, such as ['summarize']",
    ],
    [{ prompts: [1] }, 'Clerk error: mcpAuth publicAccess.prompts must be true, false, or a list'],
  ])('rejects %j', (publicAccess, message) => {
    expect(() => assertPublicAccess('mcpAuth', publicAccess)).toThrow(message);
  });

  test('every entry point checks it, and the metadata handler accepts it', () => {
    expect(() =>
      assertMcpAuthOptions('withClerkMcpAuth', { publicAccess: { tools: [''] } }),
    ).toThrow('Clerk error: withClerkMcpAuth publicAccess.tools must be a list of tool names');
    expect(() =>
      assertProtectedResourceMetadataOptions({
        resourceUrl: 'https://mcp.example.com/mcp',
        publicAccess: { methods: true, tools: ['search_docs'] },
      }),
    ).not.toThrow();
    expect(() =>
      assertProtectedResourceMetadataOptions({ publicAccess: { methods: ['tools/call'] } }),
    ).toThrow(
      'Clerk error: protectedResourceMetadataHandler publicAccess.methods cannot list tools/call',
    );
  });
});

describe('readJsonBody', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    });

  test('parses the body and leaves the request readable', async () => {
    const request = post('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    await expect(readJsonBody(request)).resolves.toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await expect(request.json()).resolves.toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  test.each([
    ['a body that is not JSON', post('initialize')],
    ['an empty body', post('')],
    ['JSON sent as text/plain', post('{"method":"ping"}', { 'content-type': 'text/plain' })],
    ['a request without a body', new Request('https://mcp.example.com/mcp')],
  ])('returns undefined for %s', async (_label, request) => {
    await expect(readJsonBody(request)).resolves.toBeUndefined();
  });

  test('returns undefined for a body over the limit, by its Content-Length', async () => {
    const request = post('{}', { 'content-length': String(PUBLIC_BODY_LIMIT + 1) });
    await expect(readJsonBody(request)).resolves.toBeUndefined();
  });

  test('stops reading a streamed body at the limit', async () => {
    const chunk = new TextEncoder().encode(' '.repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: stream,
      // @ts-expect-error - Node needs `duplex` for a stream body, and the DOM types do not have it
      duplex: 'half',
    });
    await expect(readJsonBody(request)).resolves.toBeUndefined();
    // An endless body: the read ended because of the limit, a little past it
    expect(sent).toBeLessThan(PUBLIC_BODY_LIMIT * 2);
  });

  test('reads a streamed byte view without including bytes outside the view', async () => {
    const bytes = new TextEncoder().encode('ignore{"message":"café"}ignore');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(6, -6));
        controller.close();
      },
    });
    const request = new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // @ts-expect-error - Node needs `duplex` for a stream body, and the DOM types do not have it
      duplex: 'half',
    });

    await expect(readJsonBody(request)).resolves.toEqual({ message: 'café' });
    await expect(request.json()).resolves.toEqual({ message: 'café' });
  });

  test('reads a body exactly at the limit', async () => {
    const padding = ' '.repeat(PUBLIC_BODY_LIMIT - 2);
    await expect(readJsonBody(post(`{}${padding}`))).resolves.toEqual({});
  });

  test('throws a setup error for a body that was already read', async () => {
    const request = post('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    await request.json();

    await expect(readJsonBody(request)).rejects.toThrow(
      'Clerk error: publicAccess reads the body of the request, and something before the auth check already read it. Read a copy there instead, as request.clone().json()',
    );
  });
});
