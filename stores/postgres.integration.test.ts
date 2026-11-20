// Runs against a real PostgreSQL when MCP_TOOLS_TEST_PG_URL is set, for example
//   MCP_TOOLS_TEST_PG_URL=postgresql://postgres:pw@localhost:5432/postgres pnpm test stores/postgres
import pg from 'pg';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { completeOAuth, createDynamicallyRegisteredMcpClient } from '../client';
import { createPostgresStore } from './postgres';

const connectionString = process.env.MCP_TOOLS_TEST_PG_URL;
const runId = Math.random().toString(36).slice(2, 8);
const tables: string[] = [];

/** A table name no other run uses, dropped after the file runs. */
function newTable(name: string) {
  const table = `mcp_tools_test_${name}_${runId}`;
  tables.push(table);
  return table;
}

describe.skipIf(!connectionString)('createPostgresStore against PostgreSQL', () => {
  const stores: ReturnType<typeof createPostgresStore>[] = [];

  function openStore(tableName: string) {
    const store = createPostgresStore({ connectionString, tableName });
    stores.push(store);
    return store;
  }

  afterAll(async () => {
    await Promise.all(stores.map((store) => store.disconnect()));
    const client = new pg.Client({ connectionString });
    await client.connect();
    for (const table of tables) {
      await client.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await client.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each([
    ['a string', 'session-id'],
    ['a string of digits', '123'],
    ['a string that reads as a boolean', 'true'],
    ['a string holding JSON', '{"a":1}'],
    ['an empty string', ''],
    ['a number', 123],
    ['a boolean', false],
    ['null', null],
    ['an array', [1, 'two', { three: [3] }]],
    ['an object', { string: 'héllo "quoted" \\ \n', number: 0.1 + 0.2, big: 1e21, nil: null }],
  ])('read returns %s as written', async (_name, value) => {
    const store = openStore(newTable('round_trip'));
    await store.write('key', value);

    expect(await store.read('key')).toEqual(value);
  });

  test('read returns rows written by earlier versions of the store', async () => {
    const tableName = newTable('earlier_rows');
    const store = openStore(tableName);
    await store.exists('key');
    // Earlier versions wrote the same parameter: the JSON text of the value
    const client = new pg.Client({ connectionString });
    await client.connect();
    for (const [key, value] of [
      ['state_abc', 'a7d1c0e2-4f3b-4e7a-9c1d-2b8e6f0a5c34'],
      ['pkce_verifier_abc', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
      ['session_a7d1', { mcpEndpoint: 'https://mcp.example/mcp', clientId: 'abc' }],
    ] as const) {
      await client.query(`INSERT INTO ${tableName} (key, value) VALUES ($1, $2)`, [
        key,
        JSON.stringify(value),
      ]);
    }
    await client.end();

    expect(await store.read('state_abc')).toBe('a7d1c0e2-4f3b-4e7a-9c1d-2b8e6f0a5c34');
    expect(await store.read('pkce_verifier_abc')).toBe(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
    expect(await store.read('session_a7d1')).toEqual({
      mcpEndpoint: 'https://mcp.example/mcp',
      clientId: 'abc',
    });
  });

  test('stores opening together on a new table all start', async () => {
    const tableName = newTable('concurrent_init');
    const opened = Array.from({ length: 8 }, () => openStore(tableName));

    const results = await Promise.allSettled(
      opened.map((store, index) => store.write(`key-${index}`, index)),
    );

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect((await opened[0].keys()).sort()).toEqual(
      opened.map((_store, index) => `key-${index}`).sort(),
    );
  });

  test('completeOAuth finishes the OAuth callback with the state and verifier it stored', async () => {
    const store = openStore(newTable('oauth_callback'));
    const mcpEndpoint = 'https://mcp.example/mcp';
    const issuer = 'https://auth.example/';
    const tokenRequests: URLSearchParams[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.href === mcpEndpoint) {
          return new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
          return Response.json({ resource: mcpEndpoint, authorization_servers: [issuer] });
        }
        if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}authorize`,
            token_endpoint: `${issuer}token`,
            registration_endpoint: `${issuer}register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          });
        }
        if (url.pathname === '/register' && init?.method === 'POST') {
          return Response.json({
            client_id: 'registered-client',
            client_secret: 'registered-secret',
            redirect_uris: ['https://app.example/oauth/callback'],
          });
        }
        if (url.pathname === '/token' && init?.method === 'POST') {
          tokenRequests.push(new URLSearchParams(String(init.body)));
          return Response.json({
            access_token: 'access',
            refresh_token: 'refresh',
            token_type: 'Bearer',
          });
        }
        return new Response(null, { status: 404 });
      }),
    );
    const redirect = vi.fn();
    const { connect, sessionId } = await createDynamicallyRegisteredMcpClient({
      mcpEndpoint,
      oauthRedirectUrl: 'https://app.example/oauth/callback',
      mcpClientName: 'test client',
      mcpClientVersion: '1.0.0',
      redirect,
      store,
    });

    await expect(connect()).rejects.toThrow('Unauthorized');
    const authorizationUrl = new URL(redirect.mock.calls[0][0]);
    const state = authorizationUrl.searchParams.get('state')!;

    const completed = await completeOAuth({ state, code: 'authorization-code', store });

    expect(completed.sessionId).toBe(sessionId);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get('code')).toBe('authorization-code');
    expect(tokenRequests[0].get('code_verifier')).toBe(await store.read(`pkce_verifier_${state}`));
    expect(await store.read(`session_${sessionId}`)).toMatchObject({
      clientId: 'registered-client',
      accessToken: 'access',
      refreshToken: 'refresh',
      authComplete: true,
    });
  });
});
