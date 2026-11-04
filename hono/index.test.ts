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

vi.mock('hono/adapter', () => ({
  env: vi.fn(() => process.env),
}));

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { getAuth } from '@clerk/hono';
import { env } from 'hono/adapter';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jwtWith } from '../test/jwt';
import { generateClerkProtectedResourceMetadata } from '../server';

import {
  protectedResourceHandler,
  protectedResourceHandlerClerk,
  authServerMetadataHandlerClerk,
  mcpAuth,
  mcpAuthClerk,
  createMcpAuthClerk,
  streamableHttpHandler,
} from './index';

const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
const mcpHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
});

function createMcpServer() {
  return new McpServer({ name: 'test-server', version: '1.0.0' });
}

describe('protectedResourceHandler', () => {
  test('returns metadata with auth server URL and derived resource URL', async () => {
    const app = new Hono();
    app.get(
      '/.well-known/oauth-protected-resource',
      protectedResourceHandler({ authServerUrl: 'https://auth.example.com' }),
    );

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
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

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource/mcp');
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

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    const json = await res.json();
    expect(json.scopes_supported).toEqual(['read', 'write']);
  });
});

describe('protectedResourceHandlerClerk', () => {
  beforeEach(() => {
    vi.mocked(env).mockImplementation(() => process.env);
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  });

  test('derives auth server URL from CLERK_PUBLISHABLE_KEY', async () => {
    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceHandlerClerk());

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorization_servers).toEqual(['https://clerk.example.com']);
    expect(json.resource).toBe('http://myapp.com/');
  });

  test('works in edge runtimes without Node.js Buffer', () => {
    const metadata = (() => {
      vi.stubGlobal('Buffer', undefined);
      try {
        return generateClerkProtectedResourceMetadata({
          publishableKey: FAKE_PK,
          resourceUrl: 'https://mcp.example.com',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    })();

    expect(metadata.authorization_servers).toEqual(['https://clerk.example.com']);
  });

  test('reads CLERK_PUBLISHABLE_KEY through Hono adapter env', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    vi.mocked(env).mockReturnValue({ CLERK_PUBLISHABLE_KEY: FAKE_PK });

    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceHandlerClerk());

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorization_servers).toEqual(['https://clerk.example.com']);
  });

  test('returns 500 when CLERK_PUBLISHABLE_KEY is missing', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceHandlerClerk());

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    expect(res.status).toBe(500);
  });
});

describe('authServerMetadataHandlerClerk', () => {
  beforeEach(() => {
    vi.mocked(env).mockImplementation(() => process.env);
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  });

  test('returns fetched Clerk metadata', async () => {
    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);

    const res = await app.request('http://myapp.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issuer).toBe('https://clerk.example.com');
  });

  test('reads CLERK_PUBLISHABLE_KEY through Hono adapter env', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    vi.mocked(env).mockReturnValue({ CLERK_PUBLISHABLE_KEY: FAKE_PK });

    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);

    const res = await app.request('http://myapp.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issuer).toBe('https://clerk.example.com');
  });

  test('returns 500 when CLERK_PUBLISHABLE_KEY is missing', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);

    const res = await app.request('http://myapp.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(500);
  });
});

describe('mcpAuth', () => {
  test('returns 401 with WWW-Authenticate when Authorization header is missing', async () => {
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth(async () => undefined),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp');
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toMatch(/^Bearer resource_metadata=/);
  });

  test('returns 401 when verifyToken returns undefined', async () => {
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth(async () => undefined),
      (c) => c.json({ ok: true }),
    );

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

  test('returns 401 when Authorization header has no token value', async () => {
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth(async () => undefined),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer' },
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toMatch(/^Bearer resource_metadata=/);
  });

  test('returns 401 and does not verify when Authorization scheme is not Bearer', async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      token: 'valid',
      scopes: ['read'],
      clientId: 'client-1',
    });
    const app = new Hono();
    app.get('/mcp', mcpAuth(verifyToken), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Basic valid' },
    });

    expect(res.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer resource_metadata=/);
  });

  test('returns 401 and does not verify when Bearer header has extra parts', async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      token: 'valid',
      scopes: ['read'],
      clientId: 'client-1',
    });
    const app = new Hono();
    app.get('/mcp', mcpAuth(verifyToken), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer valid extra' },
    });

    expect(res.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer resource_metadata=/);
  });
});

describe('mcpAuthClerk', () => {
  test('returns 401 when Clerk auth is not authenticated', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: false } as ReturnType<typeof getAuth>);

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
    } as ReturnType<typeof getAuth>);

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
      extra: { userId: 'user-1', verifiedBy: 'clerk' },
    });
  });
});

describe('createMcpAuthClerk', () => {
  const oauthAuth = {
    isAuthenticated: true,
    tokenType: 'oauth_token',
    clientId: 'client-1',
    scopes: ['email'],
    userId: 'user-1',
  };

  // Stands in for what `clerkMiddleware` sets, and records how the token was verified.
  function appWith(
    options: Parameters<typeof createMcpAuthClerk>[0],
    authObject: object = oauthAuth,
  ) {
    const authenticateRequest = vi.fn(async () => ({ toAuth: () => authObject }));
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('clerk', { authenticateRequest } as never);
      await next();
    });
    app.post('/mcp', createMcpAuthClerk(options), (c) => c.json(c.get('mcpAuth')));
    const post = (headers: Record<string, string> = { Authorization: 'Bearer valid-token' }) =>
      app.request('https://mcp.example.com/mcp', { method: 'POST', headers });
    return { post, authenticateRequest };
  }

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '  '],
    ['an empty list', []],
    ['a list with an empty value', ['https://mcp.example.com/mcp', '']],
    ['not a string', 42],
  ])('throws when the audience is %s', (_name, audience) => {
    expect(() => createMcpAuthClerk({ audience } as never)).toThrow(/^Clerk error: /);
  });

  test('throws when resourceMetadataUrl is not an HTTPS URL', () => {
    expect(() =>
      createMcpAuthClerk({ audience: 'a', resourceMetadataUrl: 'http://example.com/prm' }),
    ).toThrow(/^Clerk error: .*resourceMetadataUrl/);
  });

  test('verifies the token for the audience as an OAuth token', async () => {
    const { post, authenticateRequest } = appWith({
      audience: ['https://mcp.example.com/mcp', 'x'],
    });
    expect((await post()).status).toBe(200);
    expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      acceptsToken: 'oauth_token',
      audience: ['https://mcp.example.com/mcp', 'x'],
    });
  });

  test('sets resourceMetadataUrl to the URL that the 401 advertises', async () => {
    const { post } = appWith({ audience: 'https://mcp.example.com/mcp' });
    expect(await (await post()).json()).toEqual({
      token: 'valid-token',
      scopes: ['email'],
      clientId: 'client-1',
      extra: { userId: 'user-1', verifiedBy: 'clerk' },
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    });
  });

  test('lets resourceMetadataUrl override the default', async () => {
    const { post } = appWith({
      audience: 'https://mcp.example.com/mcp',
      resourceMetadataUrl: 'https://public.example.com/.well-known/oauth-protected-resource/mcp',
    });
    expect(await (await post()).json()).toMatchObject({
      resourceMetadataUrl: 'https://public.example.com/.well-known/oauth-protected-resource/mcp',
    });
  });

  test('answers 401 when Clerk does not authenticate the token', async () => {
    const { post } = appWith({ audience: 'a' }, { isAuthenticated: false });
    expect((await post()).status).toBe(401);
  });

  test('answers 401 with the metadata URL when there is no token', async () => {
    const { post, authenticateRequest } = appWith({ audience: 'a' });
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata=https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    );
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  describe('audience check of its own, when Clerk verification succeeds', () => {
    const audience = 'https://mcp.example.com/mcp';
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

    test.each([
      ['has no aud', {}],
      ['has an empty aud', { aud: '' }],
      ['has an empty aud list', { aud: [] }],
      ['is for another resource', { aud: 'https://other.example.com/mcp' }],
    ])('answers 401 for a JWT that %s', async (_name, claims) => {
      const { post } = appWith({ audience });
      expect((await post(bearer(jwtWith(claims)))).status).toBe(401);
    });

    test('passes a JWT whose aud matches, with that token in the auth info', async () => {
      const { post } = appWith({ audience });
      const token = jwtWith({ aud: [audience, 'x'] });
      const res = await post(bearer(token));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ token });
    });
  });

  test('says that clerkMiddleware must run first', async () => {
    const app = new Hono();
    app.onError((error, c) => c.text(error.message, 500));
    app.post('/mcp', createMcpAuthClerk({ audience: 'a' }), (c) => c.json({}));
    const res = await app.request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/^Clerk error: .*clerkMiddleware/);
  });
});

describe('streamableHttpHandler', () => {
  test('handles an MCP initialize request and returns 200', async () => {
    const app = new Hono();
    app.post('/mcp', streamableHttpHandler(createMcpServer));

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    });

    expect(res.status).toBe(200);
    await res.text();
  });

  test('handles sequential requests', async () => {
    const app = new Hono();
    app.post('/mcp', streamableHttpHandler(createMcpServer));

    const opts = {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    };

    const res1 = await app.request('http://localhost/mcp', opts);
    await res1.text();
    const res2 = await app.request('http://localhost/mcp', opts);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    await res2.text();
  });

  test('does not block a new request on an unconsumed response', async () => {
    const createServer = vi.fn(createMcpServer);
    const app = new Hono();
    app.post('/mcp', streamableHttpHandler(createServer));

    const opts = {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    };

    const res1 = await app.request('http://localhost/mcp', opts);
    const res2 = await app.request('http://localhost/mcp', opts);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(createServer).toHaveBeenCalledTimes(2);
    await res1.text();
    await res2.text();
  });

  test('forwards authInfo from context to the transport', async () => {
    const authInfo: AuthInfo = {
      token: 'tok',
      scopes: ['read'],
      clientId: 'c1',
      extra: { userId: 'u1' },
    };
    const app = new Hono();
    app.post(
      '/mcp',
      (c, next) => {
        c.set('mcpAuth', authInfo);
        return next();
      },
      streamableHttpHandler(createMcpServer),
    );

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    });

    expect(res.status).toBe(200);
    await res.text();
  });

  test('returns SDK 406 response when POST Accept header is missing', async () => {
    const app = new Hono();
    app.post('/mcp', streamableHttpHandler(createMcpServer));

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: initializeBody,
    });

    expect(res.status).toBe(406);
    const json = await res.json();
    expect(json.error.message).toContain(
      'Client must accept both application/json and text/event-stream',
    );
  });
});
