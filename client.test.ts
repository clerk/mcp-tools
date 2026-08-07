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

import { completeAuthWithCode, createDynamicallyRegisteredMcpClient } from './client';
import type { JsonSerializable, McpClientStore } from './client';

const BASE_URL = 'http://localhost:39999';

// A minimal OAuth authorization server + protected MCP endpoint, served
// through a global fetch stub so the SDK's own auth machinery drives the flow.
function mockOAuthServer({ advertiseIss = false }: { advertiseIss?: boolean } = {}) {
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
        authorization_servers: [BASE_URL],
      });
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return Response.json({
        issuer: BASE_URL,
        authorization_endpoint: `${BASE_URL}/authorize`,
        token_endpoint: `${BASE_URL}/token`,
        registration_endpoint: `${BASE_URL}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        ...(advertiseIss ? { authorization_response_iss_parameter_supported: true } : {}),
      });
    }

    if (url.pathname === '/register') {
      const body = JSON.parse(String(init?.body));
      return Response.json(
        {
          client_id: 'dyn_client_123',
          client_secret: 'dyn_secret_456',
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
    expect(authorizeUrl.searchParams.get('client_id')).toBe('dyn_client_123');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(state).toBeTruthy();

    const result = await completeAuthWithCode({ state, code: randomUUID(), store });

    expect(result.sessionId).toBe(sessionId);

    const session = await readSession(store, sessionId);
    expect(session.clientId).toBe('dyn_client_123');
    expect(session.accessToken).toBe('access_token_123');
    expect(session.refreshToken).toBe('refresh_token_456');
    expect(session.authComplete).toBe(true);
  });
});

describe('authorization response iss validation (RFC 9207)', () => {
  function memoryStore(): McpClientStore {
    const data = new Map<string, JsonSerializable>();
    return {
      read: async (key) => data.get(key) ?? null,
      write: async (key, value) => {
        data.set(key, value);
      },
    };
  }

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
