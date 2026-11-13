import { describe, expect, test, vi } from 'vitest';

import {
  PUBLIC_BODY_LIMIT,
  assertMcpAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertPublicAccess,
  authenticateBearer,
  clerkProtectedResourceMetadata,
  failureHeaders,
  isPublicRequest,
  readJsonBody,
  resourceFromMetadataUrl,
  resourceMetadataUrlFor,
  verifyClerkOAuthToken,
} from './bearer-auth';
import { type PublicAccess, McpAuthError, McpTokenVerificationError } from './server';

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
    overrides: Partial<Parameters<typeof authenticateBearer>[0]> = {},
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

  test.each([
    'initialize',
    'notifications/initialized',
    'server/discover',
    'ping',
    'tools/list',
    'resources/list',
    'resources/templates/list',
    'prompts/list',
  ])('methods: true opens %s', async (method) => {
    await expect(withoutToken({ methods: true }, rpc(method))).resolves.toEqual(open);
  });

  test('a methods list opens only the methods it names', async () => {
    const publicAccess: PublicAccess = { methods: ['initialize', 'tools/list'] };
    await expect(withoutToken(publicAccess, rpc('initialize'))).resolves.toEqual(open);
    await expect(withoutToken(publicAccess, rpc('tools/list'))).resolves.toEqual(open);
    await expect(withoutToken(publicAccess, rpc('resources/list'))).resolves.toMatchObject(
      challenged,
    );
    await expect(withoutToken(publicAccess, rpc('ping'))).resolves.toMatchObject(challenged);
  });

  test('notifications/initialized follows initialize, not the other methods', async () => {
    const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
    await expect(withoutToken({ methods: ['initialize'] }, notification)).resolves.toEqual(open);
    await expect(
      withoutToken({ methods: ['server/discover', 'tools/list'] }, notification),
    ).resolves.toMatchObject(challenged);
  });

  test.each([
    ['tools/call', { name: 'search_docs' }],
    ['resources/read', { uri: 'docs://index' }],
    ['prompts/get', { name: 'summarize' }],
  ])('methods: true does not open %s', async (method, params) => {
    await expect(withoutToken({ methods: true }, rpc(method, params))).resolves.toMatchObject(
      challenged,
    );
  });

  test('tools opens a tools/call only for a tool it names', async () => {
    const publicAccess: PublicAccess = { tools: ['search_docs'] };
    await expect(
      withoutToken(publicAccess, rpc('tools/call', { name: 'search_docs', arguments: {} })),
    ).resolves.toEqual(open);
    await expect(
      withoutToken(publicAccess, rpc('tools/call', { name: 'whoami' })),
    ).resolves.toMatchObject(challenged);
  });

  test.each([
    ['a name inherited from Object.prototype', { name: 'constructor' }],
    ['__proto__', { name: '__proto__' }],
    ['a name that is not a string', { name: ['search_docs'] }],
    ['no name', {}],
    ['no params', undefined],
  ])('tools does not open a tools/call with %s', async (_label, params) => {
    await expect(
      withoutToken({ tools: ['search_docs'] }, rpc('tools/call', params)),
    ).resolves.toMatchObject(challenged);
  });

  test('resources and prompts open resources/read and prompts/get, and nothing else', async () => {
    await expect(
      withoutToken({ resources: true }, rpc('resources/read', { uri: 'docs://index' })),
    ).resolves.toEqual(open);
    await expect(
      withoutToken({ prompts: true }, rpc('prompts/get', { name: 'summarize' })),
    ).resolves.toEqual(open);
    await expect(
      withoutToken({ resources: true }, rpc('prompts/get', { name: 'summarize' })),
    ).resolves.toMatchObject(challenged);
    // The list is a protocol method, which only `methods` opens
    await expect(withoutToken({ resources: true }, rpc('resources/list'))).resolves.toMatchObject(
      challenged,
    );
  });

  test('a resources list opens a resources/read only for a URI it names, exactly', async () => {
    const publicAccess: PublicAccess = { resources: ['docs://index'] };
    await expect(
      withoutToken(publicAccess, rpc('resources/read', { uri: 'docs://index' })),
    ).resolves.toEqual(open);
    for (const params of [
      { uri: 'docs://private' },
      { uri: 'docs://index/' },
      { uri: 'DOCS://index' },
      { uri: ['docs://index'] },
      { name: 'docs://index' },
      undefined,
    ]) {
      await expect(
        withoutToken(publicAccess, rpc('resources/read', params)),
      ).resolves.toMatchObject(challenged);
    }
    await expect(
      withoutToken({ resources: [] }, rpc('resources/read', { uri: 'docs://index' })),
    ).resolves.toMatchObject(challenged);
    await expect(
      withoutToken({ resources: false }, rpc('resources/read', { uri: 'docs://index' })),
    ).resolves.toMatchObject(challenged);
  });

  test('a prompts list opens a prompts/get only for a prompt it names', async () => {
    const publicAccess: PublicAccess = { prompts: ['summarize'] };
    await expect(
      withoutToken(publicAccess, rpc('prompts/get', { name: 'summarize' })),
    ).resolves.toEqual(open);
    for (const params of [{ name: 'draft_reply' }, { name: 'constructor' }, {}, undefined]) {
      await expect(withoutToken(publicAccess, rpc('prompts/get', params))).resolves.toMatchObject(
        challenged,
      );
    }
    // A list for one kind of call opens nothing of another kind
    await expect(
      withoutToken(publicAccess, rpc('tools/call', { name: 'summarize' })),
    ).resolves.toMatchObject(challenged);
    await expect(
      withoutToken(publicAccess, rpc('resources/read', { uri: 'summarize' })),
    ).resolves.toMatchObject(challenged);
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

  test('a batch passes only when every message in it is open', async () => {
    const publicAccess: PublicAccess = { methods: true, tools: ['search_docs'] };
    const publicCall = rpc('tools/call', { name: 'search_docs' });
    await expect(withoutToken(publicAccess, [rpc('tools/list'), publicCall])).resolves.toEqual(
      open,
    );
    await expect(
      withoutToken(publicAccess, [publicCall, rpc('tools/call', { name: 'whoami' })]),
    ).resolves.toMatchObject(challenged);
    await expect(withoutToken(publicAccess, [])).resolves.toMatchObject(challenged);
  });

  test.each([
    ['a body that could not be read', undefined],
    ['null', null],
    ['a string', 'initialize'],
    ['a JSON-RPC response', { jsonrpc: '2.0', id: 1, result: {} }],
    [
      'a notification this package does not know',
      { jsonrpc: '2.0', method: 'notifications/custom' },
    ],
    ['an unknown method', { jsonrpc: '2.0', id: 1, method: 'tasks/get' }],
    ['a method that is not a string', { jsonrpc: '2.0', id: 1, method: ['initialize'] }],
  ])('does not open %s', async (_label, body) => {
    await expect(
      withoutToken({ methods: true, tools: ['search_docs'], resources: true, prompts: true }, body),
    ).resolves.toMatchObject(challenged);
  });

  test('the 401 for a protected call names the scopes and carries no error code', async () => {
    const result = await withoutToken({ methods: true }, rpc('tools/call', { name: 'whoami' }), {
      resourceUrl: 'https://mcp.example.com/mcp',
      challengeScopes: ['profile', 'email'],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      challenge:
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="profile email"',
    });
  });

  test.each([
    { methods: true },
    { methods: ['initialize'] },
    { methods: ['server/discover'] },
  ] as const)(
    'answers a GET without a token with a 405 when %j opens the handshake',
    async (publicAccess) => {
      const result = await withoutToken(publicAccess, undefined, { method: 'GET' });
      expect(result).toEqual({
        ok: false,
        failure: undefined,
        status: 405,
        challenge: undefined,
        error: 'method_not_allowed',
      });
      expect(failureHeaders(result as Extract<typeof result, { ok: false }>)).toEqual({
        Allow: 'POST',
      });
    },
  );

  test.each([{ methods: ['ping', 'tools/list'] }, { tools: ['search_docs'] }, {}] as const)(
    'answers a GET without a token with the 401 when %j leaves the handshake closed',
    async (publicAccess) => {
      await expect(withoutToken(publicAccess, undefined, { method: 'GET' })).resolves.toMatchObject(
        challenged,
      );
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

  test('isPublicRequest applies the same rule to a parsed body', () => {
    expect(isPublicRequest({ methods: true }, rpc('tools/list'))).toBe(true);
    expect(isPublicRequest({ methods: true }, rpc('tools/call', { name: 'whoami' }))).toBe(false);
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
    expect(() => assertMcpAuthOptions('withMcpAuth', { publicAccess: { tools: [''] } })).toThrow(
      'Clerk error: withMcpAuth publicAccess.tools must be a list of tool names',
    );
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
