import { Hono } from 'hono';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('@clerk/hono', () => ({
  getAuth: vi.fn(),
}));

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { getAuth } from '@clerk/hono';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  protectedResourceHandler,
  protectedResourceHandlerClerk,
  authServerMetadataHandlerClerk,
  mcpAuth,
  mcpAuthClerk,
  streamableHttpHandler,
} from './index';

// A fake publishable key that decodes to "https://clerk.example.com"
// Buffer.from('clerk.example.com$').toString('base64') === 'Y2xlcmsuZXhhbXBsZS5jb20k'
const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';

describe('protectedResourceHandler', () => {
  test('returns metadata with auth server URL and derived resource URL', async () => {
    const app = new Hono();
    app.get(
      '/.well-known/oauth-protected-resource',
      protectedResourceHandler({ authServerUrl: 'https://auth.example.com' }),
    );

    const res = await app.request(
      'http://myapp.com/.well-known/oauth-protected-resource',
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.resource).toBe('http://myapp.com/');
    expect(json.authorization_servers).toEqual(['https://auth.example.com']);
  });

  test('strips sub-path from resource URL', async () => {
    const app = new Hono();
    app.get(
      '/.well-known/oauth-protected-resource/mcp',
      protectedResourceHandler({ authServerUrl: 'https://auth.example.com' }),
    );

    const res = await app.request(
      'http://myapp.com/.well-known/oauth-protected-resource/mcp',
    );
    const json = await res.json();
    expect(json.resource).toBe('http://myapp.com/mcp');
  });

  test('merges additional properties', async () => {
    const app = new Hono();
    app.get(
      '/.well-known/oauth-protected-resource',
      protectedResourceHandler({
        authServerUrl: 'https://auth.example.com',
        properties: { scopes_supported: ['read', 'write'] },
      }),
    );

    const res = await app.request(
      'http://myapp.com/.well-known/oauth-protected-resource',
    );
    const json = await res.json();
    expect(json.scopes_supported).toEqual(['read', 'write']);
  });
});

describe('protectedResourceHandlerClerk', () => {
  beforeEach(() => {
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  });

  test('derives auth server URL from CLERK_PUBLISHABLE_KEY', async () => {
    const app = new Hono();
    app.get(
      '/.well-known/oauth-protected-resource',
      protectedResourceHandlerClerk(),
    );

    const res = await app.request(
      'http://myapp.com/.well-known/oauth-protected-resource',
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorization_servers).toEqual(['https://clerk.example.com']);
    expect(json.resource).toBe('http://myapp.com/');
  });

  test('returns 500 when CLERK_PUBLISHABLE_KEY is missing', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const app = new Hono();
    app.get(
      '/.well-known/oauth-protected-resource',
      protectedResourceHandlerClerk(),
    );

    const res = await app.request(
      'http://myapp.com/.well-known/oauth-protected-resource',
    );
    expect(res.status).toBe(500);
  });
});

describe('authServerMetadataHandlerClerk', () => {
  beforeEach(() => {
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  });

  test('returns fetched Clerk metadata', async () => {
    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);

    const res = await app.request(
      'http://myapp.com/.well-known/oauth-authorization-server',
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issuer).toBe('https://clerk.example.com');
  });

  test('returns 500 when CLERK_PUBLISHABLE_KEY is missing', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);

    const res = await app.request(
      'http://myapp.com/.well-known/oauth-authorization-server',
    );
    expect(res.status).toBe(500);
  });
});

describe('mcpAuth', () => {
  test('returns 401 with WWW-Authenticate when Authorization header is missing', async () => {
    const app = new Hono();
    app.get('/mcp', mcpAuth(async () => undefined), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp');
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toMatch(/^Bearer resource_metadata=/);
  });

  test('returns 401 when verifyToken returns undefined', async () => {
    const app = new Hono();
    app.get('/mcp', mcpAuth(async () => undefined), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer bad-token' },
    });
    expect(res.status).toBe(401);
  });

  test('calls next and stores authInfo in context when token is valid', async () => {
    const authInfo: AuthInfo = {
      token: 'valid',
      scopes: ['read'],
      clientId: 'client-1',
      extra: { userId: 'user-1' },
    };
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth(async () => authInfo),
      (c) => c.json(c.get('mcpAuth')),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer valid' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(authInfo);
  });

  test('passes token and context to verifyToken', async () => {
    const verifyToken = vi.fn().mockResolvedValue(undefined);
    const app = new Hono();
    app.get('/mcp', mcpAuth(verifyToken), (c) => c.json({ ok: true }));

    await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer my-token' },
    });

    expect(verifyToken).toHaveBeenCalledWith('my-token', expect.any(Object));
  });
});

describe('mcpAuthClerk', () => {
  test('returns 401 when Clerk auth is not authenticated', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: false } as any);

    const app = new Hono();
    app.post('/mcp', mcpAuthClerk, (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(401);
  });

  test('sets authInfo in context when Clerk auth succeeds', async () => {
    vi.mocked(getAuth).mockReturnValue({
      isAuthenticated: true,
      tokenType: 'oauth_token',
      clientId: 'client-1',
      scopes: ['read', 'email'],
      userId: 'user-1',
    } as any);

    const app = new Hono();
    app.post('/mcp', mcpAuthClerk, (c) => c.json(c.get('mcpAuth')));

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      token: 'valid-token',
      scopes: ['read', 'email'],
      clientId: 'client-1',
      extra: { userId: 'user-1' },
    });
  });
});

describe('streamableHttpHandler', () => {
  test('handles an MCP initialize request and returns 200', async () => {
    const server = new McpServer({ name: 'test-server', version: '1.0.0' });
    const app = new Hono();
    app.post('/mcp', streamableHttpHandler(server));

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    expect(res.status).toBe(200);
  });

  test('forwards authInfo from context to the transport', async () => {
    const authInfo: AuthInfo = {
      token: 'tok',
      scopes: ['read'],
      clientId: 'c1',
      extra: { userId: 'u1' },
    };
    const server = new McpServer({ name: 'test-server', version: '1.0.0' });
    const app = new Hono();
    app.post(
      '/mcp',
      (c, next) => { c.set('mcpAuth', authInfo); return next(); },
      streamableHttpHandler(server),
    );

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    expect(res.status).toBe(200);
  });
});
