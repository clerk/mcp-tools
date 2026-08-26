import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { env } from 'hono/adapter';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  authServerMetadataHandlerClerk,
  mcpAuth,
  mcpAuthClerk,
  protectedResourceHandler,
  protectedResourceHandlerClerk,
  streamableHttpHandler,
} from './index';

vi.mock('../server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server')>();
  return {
    ...actual,
    fetchClerkAuthorizationServerMetadata: vi.fn().mockResolvedValue({
      issuer: 'https://clerk.example.com',
      authorization_endpoint: 'https://clerk.example.com/authorize',
    }),
  };
});

vi.mock('hono/adapter', () => ({
  env: vi.fn(() => process.env),
}));

const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
const legacyInitializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
});
const mcpHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const authInfo: AuthInfo = {
  token: 'valid-token',
  scopes: ['read'],
  clientId: 'client-1',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  extra: { userId: 'user-1' },
};

function createMcpServer() {
  return new McpServer({ name: 'test-server', version: '1.0.0' });
}

describe('protected resource metadata', () => {
  beforeEach(() => {
    vi.mocked(env).mockImplementation(() => process.env);
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  });

  test('derives the resource URL from the path-aware metadata route', async () => {
    const app = new Hono();
    app.get(
      '/.well-known/oauth-protected-resource/mcp',
      protectedResourceHandler({ authServerUrl: 'https://auth.example.com' }),
    );

    const response = await app.request(
      'http://myapp.com/.well-known/oauth-protected-resource/mcp?ignored=true',
    );
    const metadata = await response.json();

    expect(metadata.resource).toBe('http://myapp.com/mcp');
    expect(metadata.authorization_servers).toEqual(['https://auth.example.com']);
  });

  test('uses the Clerk publishable key from the Hono environment', async () => {
    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandlerClerk());

    const response = await app.request('http://myapp.com/.well-known/oauth-protected-resource/mcp');
    const metadata = await response.json();

    expect(metadata.resource).toBe('http://myapp.com/mcp');
    expect(metadata.authorization_servers).toEqual(['https://clerk.example.com']);
  });

  test('returns Clerk authorization server metadata', async () => {
    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);

    const response = await app.request('http://myapp.com/.well-known/oauth-authorization-server');

    expect(response.status).toBe(200);
    expect((await response.json()).issuer).toBe('https://clerk.example.com');
  });
});

describe('mcpAuth', () => {
  test('returns a path-aware SDK bearer challenge when the token is missing', async () => {
    const verifier: OAuthTokenVerifier = {
      verifyAccessToken: vi.fn(),
    };
    const app = new Hono();
    app.get('/mcp', mcpAuth(verifier), (context) => context.json({ ok: true }));

    const response = await app.request('http://localhost/mcp');

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('supports a context-aware custom token verifier', async () => {
    const verifyToken = vi.fn().mockResolvedValue(authInfo);
    const app = new Hono();
    app.get('/mcp', mcpAuth(verifyToken), (context) => context.json(context.get('mcpAuth')));

    const response = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(authInfo);
    expect(verifyToken).toHaveBeenCalledWith('valid-token', expect.any(Object));
  });

  test('accepts a Clerk OAuth token verifier', async () => {
    const clerkClient = {
      idPOAuthAccessToken: {
        verify: vi.fn().mockResolvedValue({
          clientId: authInfo.clientId,
          subject: 'user-1',
          scopes: authInfo.scopes,
          revoked: false,
          expired: false,
          expiration: authInfo.expiresAt! * 1000,
        }),
      },
    };
    const app = new Hono();
    app.get('/mcp', mcpAuthClerk({ clerkClient }), (context) =>
      context.json(context.get('mcpAuth')),
    );

    const response = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(authInfo);
  });
});

describe('streamableHttpHandler', () => {
  test('serves the modern server/discover exchange', async () => {
    const app = new Hono();
    app.all('/mcp', streamableHttpHandler(createMcpServer));
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => app.request(input, init),
    });

    await client.connect(transport);

    expect(client.getProtocolEra()).toBe('modern');
    await client.close();
  });

  test('serves a legacy initialize exchange', async () => {
    const app = new Hono();
    app.post('/mcp', streamableHttpHandler(createMcpServer));

    const response = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: legacyInitializeBody,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"protocolVersion":"2025-06-18"');
  });

  test('creates an isolated server and forwards auth for every request', async () => {
    const factory = vi.fn(() => createMcpServer());
    const app = new Hono();
    app.post(
      '/mcp',
      (context, next) => {
        context.set('mcpAuth', authInfo);
        return next();
      },
      streamableHttpHandler(factory),
    );

    const request = {
      method: 'POST',
      headers: mcpHeaders,
      body: legacyInitializeBody,
    };
    await (await app.request('http://localhost/mcp', request)).text();
    await (await app.request('http://localhost/mcp', request)).text();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ era: 'legacy', authInfo }),
    );
    expect(factory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ era: 'legacy', authInfo }),
    );
  });
});
