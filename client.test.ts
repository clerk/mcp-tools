import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory backends so the redis and postgres stores run the full flow
// without live servers — only the driver seam is mocked, never the store code.
const redisData = new Map<string, string>();
vi.mock('redis', () => ({
  default: {
    createClient: () => ({
      on: () => undefined,
      connect: async () => undefined,
      get: async (key: string) => redisData.get(key) ?? null,
      set: async (key: string, value: string) => {
        redisData.set(key, value);
      },
      setEx: async (key: string, _ttl: number, value: string) => {
        redisData.set(key, value);
      },
    }),
  },
}));

const postgresData = new Map<string, string>();
vi.mock('pg', () => ({
  default: {
    Client: class {
      on() {}
      async connect() {}
      async query(query: string, params?: string[]) {
        if (query.includes('INSERT INTO')) {
          postgresData.set(params![0]!, params![1]!);
          return { rows: [] };
        }
        if (query.includes('SELECT value FROM')) {
          const value = postgresData.get(params![0]!);
          return { rows: value === undefined ? [] : [{ value }] };
        }
        return { rows: [] };
      }
    },
  },
}));

import {
  completeAuthWithCode,
  createDynamicallyRegisteredMcpClient,
  createKnownCredentialsMcpClient,
  getClientBySessionId,
  validateAuthorizationResponseIss,
} from './client';
import type { JsonSerializable, McpClientStore } from './client';

const BASE_URL = 'http://localhost:39999';
const OTHER_AS_URL = 'http://localhost:39998';

// A minimal OAuth authorization server + protected MCP endpoint, served
// through a global fetch stub so the SDK's own auth machinery drives the flow.
// AS endpoints answer on whatever origin the request hits, so pointing
// `authServerOrigin` at a second origin simulates the AS behind the resource
// changing between flows.
function mockOAuthServer({
  advertiseIss = false,
  advertiseCimd = false,
  authServerOrigin = BASE_URL,
}: { advertiseIss?: boolean; advertiseCimd?: boolean; authServerOrigin?: string } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.pathname === '/mcp') {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
          'WWW-Authenticate': `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return Response.json({
        resource: `${BASE_URL}/mcp`,
        authorization_servers: [authServerOrigin],
      });
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return Response.json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        registration_endpoint: `${url.origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        ...(advertiseIss ? { authorization_response_iss_parameter_supported: true } : {}),
        ...(advertiseCimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }

    if (url.pathname === '/register') {
      const body = JSON.parse(String(init?.body));
      return Response.json(
        {
          client_id: `dyn_client_${url.port}`,
          client_secret: `dyn_secret_${url.port}`,
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: 'client_secret_post',
        },
        { status: 201 },
      );
    }

    if (url.pathname === '/token') {
      return Response.json({
        access_token: 'access_token_123',
        token_type: 'Bearer',
        refresh_token: 'refresh_token_456',
        expires_in: 3600,
      });
    }

    return new Response('Not found', { status: 404 });
  });
}

interface StoreCase {
  name: string;
  createStore: () => Promise<McpClientStore>;
}

const storeCases: StoreCase[] = [
  {
    name: 'fs',
    createStore: async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tools-fs-'));
      const { createFsStore } = await import('./stores/fs');
      return createFsStore({ filePath: path.join(dir, 'store.json') });
    },
  },
  {
    name: 'sqlite',
    createStore: async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tools-sqlite-'));
      const { createSqliteStore } = await import('./stores/sqlite');
      return createSqliteStore({ dbPath: path.join(dir, 'store.db') });
    },
  },
  {
    name: 'redis',
    createStore: async () => {
      redisData.clear();
      const { createRedisStore } = await import('./stores/redis');
      return createRedisStore();
    },
  },
  {
    name: 'postgres',
    createStore: async () => {
      postgresData.clear();
      const { createPostgresStore } = await import('./stores/postgres');
      return createPostgresStore();
    },
  },
];

async function startAuthFlow(store: McpClientStore) {
  let redirectUrl: string | undefined;

  const { connect, sessionId } = await createDynamicallyRegisteredMcpClient({
    mcpEndpoint: `${BASE_URL}/mcp`,
    oauthRedirectUrl: `${BASE_URL}/callback`,
    mcpClientName: 'test-client',
    mcpClientVersion: '1.0.0',
    redirect: (url) => {
      redirectUrl = url;
    },
    store,
  });

  // The 401 kicks off discovery + dynamic registration, ending in a
  // redirect to the authorization endpoint instead of a connection.
  await Promise.resolve(connect()).catch(() => undefined);

  expect(redirectUrl).toBeDefined();
  const authorizeUrl = new URL(redirectUrl!);
  const state = authorizeUrl.searchParams.get('state')!;
  return { sessionId, authorizeUrl, state };
}

async function readSession(store: McpClientStore, sessionId: string) {
  return (await store.read(`session_${sessionId}`)) as Record<string, unknown>;
}

describe.each(storeCases)('OAuth redirect flow with $name store', ({ createStore }) => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockOAuthServer());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('completes dynamic registration, redirect, and token exchange', async () => {
    const store = await createStore();
    const { sessionId, authorizeUrl, state } = await startAuthFlow(store);

    expect(authorizeUrl.pathname).toBe('/authorize');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('dyn_client_39999');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(state).toBeTruthy();

    const result = await completeAuthWithCode({ state, code: randomUUID(), store });

    expect(result.sessionId).toBe(sessionId);

    const session = await readSession(store, sessionId);
    expect(session.clientId).toBe('dyn_client_39999');
    expect(session.accessToken).toBe('access_token_123');
    expect(session.refreshToken).toBe('refresh_token_456');
    expect(session.authComplete).toBe(true);
  });
});

describe('authorization response iss validation (RFC 9207)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('accepts a matching iss and completes the exchange', async () => {
    vi.stubGlobal('fetch', mockOAuthServer({ advertiseIss: true }));
    const store = memoryStore();
    const { state, sessionId } = await startAuthFlow(store);

    await completeAuthWithCode({ state, code: randomUUID(), iss: BASE_URL, store });

    const session = await readSession(store, sessionId);
    expect(session.accessToken).toBe('access_token_123');
    expect(session.authComplete).toBe(true);
  });

  test('rejects a mismatched iss without redeeming the code', async () => {
    const fetchMock = mockOAuthServer({ advertiseIss: true });
    vi.stubGlobal('fetch', fetchMock);
    const store = memoryStore();
    const { state, sessionId } = await startAuthFlow(store);

    await expect(
      completeAuthWithCode({ state, code: randomUUID(), iss: 'https://attacker.example', store }),
    ).rejects.toThrow(/Issuer mismatch/);

    const tokenCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input instanceof Request ? input.url : input).includes('/token'),
    );
    expect(tokenCalls).toHaveLength(0);

    const session = await readSession(store, sessionId);
    expect(session.accessToken).toBeUndefined();
  });

  test('rejects an omitted iss when the server advertises iss support', async () => {
    vi.stubGlobal('fetch', mockOAuthServer({ advertiseIss: true }));
    const store = memoryStore();
    const { state } = await startAuthFlow(store);

    await expect(completeAuthWithCode({ state, code: randomUUID(), store })).rejects.toThrow(
      /Issuer mismatch/,
    );
  });
});

function memoryStore(): McpClientStore {
  const data = new Map<string, JsonSerializable>();
  return {
    read: async (key) => data.get(key) ?? null,
    write: async (key, value) => {
      data.set(key, value);
    },
  };
}

describe('validateAuthorizationResponseIss on error responses (RFC 9207)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function startFlow({ advertiseIss }: { advertiseIss: boolean }) {
    vi.stubGlobal('fetch', mockOAuthServer({ advertiseIss }));
    const store = memoryStore();
    const { state } = await startAuthFlow(store);
    return { store, state };
  }

  test('accepts a matching iss', async () => {
    const { store, state } = await startFlow({ advertiseIss: true });

    await expect(
      validateAuthorizationResponseIss({ state, iss: BASE_URL, store }),
    ).resolves.toBeUndefined();
  });

  test('rejects a mismatched iss', async () => {
    const { store, state } = await startFlow({ advertiseIss: true });

    await expect(
      validateAuthorizationResponseIss({ state, iss: 'https://attacker.example', store }),
    ).rejects.toThrow(/Issuer mismatch/);
  });

  test('rejects an omitted iss when the server advertises iss support', async () => {
    const { store, state } = await startFlow({ advertiseIss: true });

    await expect(validateAuthorizationResponseIss({ state, store })).rejects.toThrow(
      /Issuer mismatch/,
    );
  });

  test('accepts an omitted iss when the server does not advertise iss support', async () => {
    const { store, state } = await startFlow({ advertiseIss: false });

    await expect(validateAuthorizationResponseIss({ state, store })).resolves.toBeUndefined();
  });

  test('rejects an unknown state', async () => {
    const { store } = await startFlow({ advertiseIss: true });

    await expect(
      validateAuthorizationResponseIss({ state: 'unknown-state', iss: BASE_URL, store }),
    ).rejects.toThrow(/No session id/);
  });
});

describe('DCR application_type (SEP-837)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function registerViaDcr({
    oauthRedirectUrl,
    oauthAdditionalRedirectUrls,
  }: {
    oauthRedirectUrl: string;
    oauthAdditionalRedirectUrls?: string[];
  }) {
    const fetchMock = mockOAuthServer();
    vi.stubGlobal('fetch', fetchMock);

    const { connect, authProvider } = await createDynamicallyRegisteredMcpClient({
      mcpEndpoint: `${BASE_URL}/mcp`,
      oauthRedirectUrl,
      oauthAdditionalRedirectUrls,
      mcpClientName: 'test-client',
      mcpClientVersion: '1.0.0',
      redirect: () => undefined,
      store: memoryStore(),
    });

    await Promise.resolve(connect()).catch(() => undefined);

    const registerCall = fetchMock.mock.calls.find(([input]) =>
      String(input instanceof Request ? input.url : input).includes('/register'),
    );
    expect(registerCall).toBeDefined();
    const body = JSON.parse(String(registerCall![1]?.body)) as Record<string, unknown>;
    return { body, authProvider };
  }

  test('a pure web redirect set registers with the SDK-derived web type', async () => {
    const { body, authProvider } = await registerViaDcr({
      oauthRedirectUrl: 'https://app.example.com/callback',
    });

    // the library leaves the field to the SDK's derivation for unmixed sets
    expect(authProvider.clientMetadata.application_type).toBeUndefined();
    expect(body.application_type).toBe('web');
  });

  test('a custom-scheme redirect set registers with the SDK-derived native type', async () => {
    const { body, authProvider } = await registerViaDcr({
      oauthRedirectUrl: 'myapp://oauth/callback',
    });

    expect(authProvider.clientMetadata.application_type).toBeUndefined();
    expect(body.application_type).toBe('native');
  });

  test('a mixed web + custom-scheme redirect set registers explicitly as native', async () => {
    const { body, authProvider } = await registerViaDcr({
      oauthRedirectUrl: 'https://app.example.com/callback',
      oauthAdditionalRedirectUrls: ['myapp://oauth/callback'],
    });

    // mixed sets are ambiguous under OIDC DCR §2, so the library pins the
    // value instead of relying on the SDK heuristic
    expect(authProvider.clientMetadata.application_type).toBe('native');
    expect(body.application_type).toBe('native');
    expect(body.redirect_uris).toEqual([
      'https://app.example.com/callback',
      'myapp://oauth/callback',
    ]);
  });
});

describe('issuer-keyed credentials (SEP-2352)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('stamps the AS issuer on persisted credentials and discovery state', async () => {
    vi.stubGlobal('fetch', mockOAuthServer());
    const store = memoryStore();
    const { state, sessionId } = await startAuthFlow(store);

    const afterRedirect = await readSession(store, sessionId);
    expect(afterRedirect.issuer).toBe(BASE_URL);
    const discovery = afterRedirect.discoveryState as Record<string, unknown>;
    expect(discovery).toBeDefined();
    expect(discovery.authorizationServerUrl).toBe(BASE_URL);

    await completeAuthWithCode({ state, code: randomUUID(), store });

    const session = await readSession(store, sessionId);
    expect(session.issuer).toBe(BASE_URL);
    expect(session.accessToken).toBe('access_token_123');
  });

  test('authProvider round-trips the issuer stamp on client information and tokens', async () => {
    vi.stubGlobal('fetch', mockOAuthServer());
    const store = memoryStore();
    const { state, sessionId } = await startAuthFlow(store);
    await completeAuthWithCode({ state, code: randomUUID(), store });

    const { authProvider } = await getClientBySessionId({ sessionId, store });

    const info = await authProvider.clientInformation({ issuer: BASE_URL });
    expect(info).toMatchObject({ client_id: 'dyn_client_39999', issuer: BASE_URL });

    const tokens = await authProvider.tokens({ issuer: BASE_URL });
    expect(tokens).toMatchObject({ access_token: 'access_token_123', issuer: BASE_URL });

    // the transport's per-request bearer read passes no ctx and must still
    // receive the most recently saved token set
    const bearer = await authProvider.tokens();
    expect(bearer?.access_token).toBe('access_token_123');
  });

  test('re-registers and drops tokens when the authorization server changes', async () => {
    vi.stubGlobal('fetch', mockOAuthServer());
    const store = memoryStore();
    const { state, sessionId } = await startAuthFlow(store);
    await completeAuthWithCode({ state, code: randomUUID(), store });

    // the resource now points at a different AS
    const fetchMock = mockOAuthServer({ authServerOrigin: OTHER_AS_URL });
    vi.stubGlobal('fetch', fetchMock);

    const { authProvider } = await getClientBySessionId({ sessionId, store });
    await authProvider.invalidateCredentials?.('discovery');

    const { auth } = await import('@modelcontextprotocol/client');
    // the redirect leg is not wired in this phase, so the flow stops after
    // re-registration when it tries to hand off to the user agent
    await expect(auth(authProvider, { serverUrl: `${BASE_URL}/mcp` })).rejects.toThrow(
      /Unexpected call/,
    );

    const registerCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input instanceof Request ? input.url : input).startsWith(`${OTHER_AS_URL}/register`),
    );
    expect(registerCalls).toHaveLength(1);

    const session = await readSession(store, sessionId);
    expect(session.clientId).toBe('dyn_client_39998');
    expect(session.issuer).toBe(OTHER_AS_URL);
    // tokens issued by the previous AS are never replayed against the new one
    expect(session.accessToken).toBeUndefined();
    expect(session.refreshToken).toBeUndefined();
  });

  test('CIMD: uses the client metadata URL as client_id when the AS supports it', async () => {
    const fetchMock = mockOAuthServer({ advertiseCimd: true });
    vi.stubGlobal('fetch', fetchMock);
    const store = memoryStore();
    const metadataUrl = 'https://client.example.com/.well-known/oauth-client-metadata.json';

    let redirectUrl: string | undefined;
    const { connect, sessionId } = await createDynamicallyRegisteredMcpClient({
      mcpEndpoint: `${BASE_URL}/mcp`,
      oauthRedirectUrl: `${BASE_URL}/callback`,
      oauthClientMetadataUrl: metadataUrl,
      mcpClientName: 'test-client',
      mcpClientVersion: '1.0.0',
      redirect: (url) => {
        redirectUrl = url;
      },
      store,
    });

    await Promise.resolve(connect()).catch(() => undefined);

    expect(redirectUrl).toBeDefined();
    const authorizeUrl = new URL(redirectUrl!);
    expect(authorizeUrl.searchParams.get('client_id')).toBe(metadataUrl);

    // CIMD replaces dynamic client registration entirely
    const registerCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input instanceof Request ? input.url : input).includes('/register'),
    );
    expect(registerCalls).toHaveLength(0);

    const state = authorizeUrl.searchParams.get('state')!;
    await completeAuthWithCode({ state, code: randomUUID(), store });

    const session = await readSession(store, sessionId);
    expect(session.clientId).toBe(metadataUrl);
    expect(session.accessToken).toBe('access_token_123');
    expect(session.authComplete).toBe(true);
  });

  test('CIMD: falls back to dynamic registration when the AS does not advertise support', async () => {
    const fetchMock = mockOAuthServer();
    vi.stubGlobal('fetch', fetchMock);
    const store = memoryStore();

    let redirectUrl: string | undefined;
    const { connect } = await createDynamicallyRegisteredMcpClient({
      mcpEndpoint: `${BASE_URL}/mcp`,
      oauthRedirectUrl: `${BASE_URL}/callback`,
      oauthClientMetadataUrl: 'https://client.example.com/oauth-client-metadata.json',
      mcpClientName: 'test-client',
      mcpClientVersion: '1.0.0',
      redirect: (url) => {
        redirectUrl = url;
      },
      store,
    });

    await Promise.resolve(connect()).catch(() => undefined);

    expect(new URL(redirectUrl!).searchParams.get('client_id')).toBe('dyn_client_39999');
  });

  test.each(['http://insecure.example/client.json', 'https://no-path.example/'])(
    'CIMD: rejects the invalid client metadata URL %s before starting the flow',
    async (oauthClientMetadataUrl) => {
      vi.stubGlobal('fetch', mockOAuthServer({ advertiseCimd: true }));

      await expect(
        createDynamicallyRegisteredMcpClient({
          mcpEndpoint: `${BASE_URL}/mcp`,
          oauthRedirectUrl: `${BASE_URL}/callback`,
          oauthClientMetadataUrl,
          mcpClientName: 'test-client',
          mcpClientVersion: '1.0.0',
          redirect: () => undefined,
          store: memoryStore(),
        }),
      ).rejects.toThrow(/clientMetadataUrl/);
    },
  );

  test('known-credentials flow persists the issuer stamp without dynamic registration', async () => {
    const fetchMock = mockOAuthServer();
    vi.stubGlobal('fetch', fetchMock);
    const store = memoryStore();

    let redirectUrl: string | undefined;
    const { connect, sessionId } = await createKnownCredentialsMcpClient({
      clientId: 'known_client',
      clientSecret: 'known_secret',
      mcpEndpoint: `${BASE_URL}/mcp`,
      oauthRedirectUrl: `${BASE_URL}/callback`,
      mcpClientName: 'test-client',
      mcpClientVersion: '1.0.0',
      redirect: (url) => {
        redirectUrl = url;
      },
      store,
    });

    await Promise.resolve(connect()).catch(() => undefined);

    expect(redirectUrl).toBeDefined();
    const authorizeUrl = new URL(redirectUrl!);
    expect(authorizeUrl.searchParams.get('client_id')).toBe('known_client');

    const registerCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input instanceof Request ? input.url : input).includes('/register'),
    );
    expect(registerCalls).toHaveLength(0);

    const session = await readSession(store, sessionId);
    expect(session.issuer).toBe(BASE_URL);

    const state = authorizeUrl.searchParams.get('state')!;
    await completeAuthWithCode({ state, code: randomUUID(), store });
    const completed = await readSession(store, sessionId);
    expect(completed.accessToken).toBe('access_token_123');
    expect(completed.authComplete).toBe(true);
  });
});
