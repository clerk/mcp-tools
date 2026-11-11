import { describe, expect, test, vi } from 'vitest';

import {
  assertMcpAuthOptions,
  assertProtectedResourceMetadataOptions,
  authenticateBearer,
  clerkProtectedResourceMetadata,
  resourceFromMetadataUrl,
  resourceMetadataUrlFor,
  verifyClerkOAuthToken,
} from './bearer-auth';
import { McpAuthError, McpTokenVerificationError } from './server';

const authInfo = { token: 't', clientId: 'client-1', scopes: ['profile'] };

function authenticate(
  overrides: Partial<Parameters<typeof authenticateBearer>[0]> = {},
): ReturnType<typeof authenticateBearer> {
  return authenticateBearer({
    authorization: 'Bearer t',
    requestUrl: 'https://mcp.example.com/mcp',
    resourceUrl: undefined,
    requiredScopes: undefined,
    challengeScopes: undefined,
    verifyToken: async () => authInfo,
    ...overrides,
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

describe('resourceFromMetadataUrl', () => {
  test.each([
    'https://mcp.example.com/mcp',
    'https://mcp.example.com/mcp/',
    'https://mcp.example.com',
    'https://mcp.example.com/mcp?tenant=a',
  ])('inverts resourceMetadataUrlFor for %s', (resource) => {
    expect(resourceFromMetadataUrl(resourceMetadataUrlFor(resource))).toBe(resource);
  });
});

describe('authenticateBearer', () => {
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
      challenge:
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    });
    expect(root).toMatchObject({
      challenge:
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
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
      challenge: undefined,
      error: 'misdirected_request',
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
    expect(passedThrough).toBe(thrown);
  });

  test('rejects a token whose expiresAt has passed, and accepts one that has not', async () => {
    const now = Math.floor(Date.now() / 1000);

    const expired = await authenticate({
      verifyToken: async () => ({ ...authInfo, expiresAt: now - 1 }),
    });
    const current = await authenticate({
      verifyToken: async () => ({ ...authInfo, expiresAt: now + 60 }),
    });

    expect(expired).toMatchObject({
      ok: false,
      status: 401,
      challenge:
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
      failure: { reason: 'invalid_token', cause: { code: 'token-expired' } },
    });
    expect(current).toMatchObject({ ok: true });
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a token whose expiresAt is %d instead of letting it through',
    async (expiresAt) => {
      const result = await authenticate({ verifyToken: async () => ({ ...authInfo, expiresAt }) });

      expect(result).toMatchObject({
        ok: false,
        status: 401,
        failure: { reason: 'invalid_token', cause: { code: 'token-expired' } },
      });
    },
  );
});

describe('McpAuthError', () => {
  test.each([500, 503, 599])('keeps a %i status from the cause', (status) => {
    expect(new McpAuthError(Object.assign(new Error('unavailable'), { status })).status).toBe(
      status,
    );
  });

  test.each([400, 401, 403, 429, 600, '503'])('drops a %j status from the cause', (status) => {
    expect(
      new McpAuthError(Object.assign(new Error('rejected'), { status })).status,
    ).toBeUndefined();
  });
});

describe('verifyClerkOAuthToken', () => {
  const authenticated = {
    isAuthenticated: true,
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: 'oauth_token',
      clientId: 'client-1',
      scopes: ['profile'],
      userId: 'user-1',
    }),
  };

  test('checks the audience against the URL as written when it is already normalized', async () => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated);

    await verifyClerkOAuthToken({ authenticateRequest }, 't', 'https://mcp.example.com/mcp');

    expect(authenticateRequest.mock.calls[0]?.[1]).toEqual({
      acceptsToken: 'oauth_token',
      audience: 'https://mcp.example.com/mcp',
    });
  });

  test.each([
    ['https://mcp.example.com', 'https://mcp.example.com/'],
    ['https://MCP.Example.com:443/mcp', 'https://mcp.example.com/mcp'],
    // The root's protected resource metadata describes the bare origin, so a client can send that form back
    ['https://mcp.example.com/', 'https://mcp.example.com'],
  ])('also accepts the other form of %s as the audience', async (resourceUrl, other) => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated);

    await verifyClerkOAuthToken({ authenticateRequest }, 't', resourceUrl);

    expect(authenticateRequest.mock.calls[0]?.[1]).toEqual({
      acceptsToken: 'oauth_token',
      audience: [resourceUrl, other],
    });
  });

  test('rejects a token Clerk accepted without a user, client, or scopes, with a cause', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const authenticateRequest = vi.fn().mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({ isAuthenticated: true, tokenType: 'oauth_token', clientId: 'client-1' }),
    });

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

const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
const metadataOrigin = 'https://mcp.example.com';
const metadataUrl = `${metadataOrigin}/.well-known/oauth-protected-resource/mcp`;

describe('clerkProtectedResourceMetadata', () => {
  const metadata = (options: Parameters<typeof clerkProtectedResourceMetadata>[0]) =>
    clerkProtectedResourceMetadata(
      { resourceUrl: 'https://public.example.com/mcp', ...options },
      metadataUrl,
      FAKE_PK,
    );

  test('merges properties over the generated metadata', () => {
    expect(
      metadata({
        properties: { scopes_supported: ['email'], resource_documentation: 'https://example.com' },
      }),
    ).toMatchObject({
      resource: 'https://public.example.com/mcp',
      scopes_supported: ['email'],
      resource_documentation: 'https://example.com',
    });
  });

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

  test.each([
    ['is not a URL', 'mcp.example.com/mcp'],
    ['has a fragment', 'https://mcp.example.com/mcp#tools'],
    ['is an empty list', []],
  ])('throws when resourceUrl %s', (_case, resourceUrl) => {
    expect(() => assertProtectedResourceMetadataOptions({ resourceUrl })).toThrow(
      'Clerk error: protectedResourceMetadataHandler resourceUrl must be',
    );
  });

  test('throws when resourceUrl lists two URLs for one origin', () => {
    expect(() =>
      assertProtectedResourceMetadataOptions({
        resourceUrl: [`${metadataOrigin}/mcp`, `${metadataOrigin}/other`],
      }),
    ).toThrow('Clerk error: protectedResourceMetadataHandler resourceUrl lists more than one URL');
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

  test('throws for a requiredScopes entry that is not a scope token', () => {
    expect(() => assertProtectedResourceMetadataOptions({ requiredScopes: ['two words'] })).toThrow(
      'Clerk error: protectedResourceMetadataHandler requiredScopes must contain only scope tokens',
    );
  });
});
