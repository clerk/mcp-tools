import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server')>();
  return {
    ...actual,
    fetchAuthorizationServerMetadata: vi.fn().mockResolvedValue({
      issuer: 'https://clerk.example.com',
      authorization_endpoint: 'https://clerk.example.com/authorize',
    }),
  };
});

vi.mock('hono/adapter', () => ({
  env: vi.fn(() => process.env),
}));

vi.mock('@clerk/backend', () => ({ createClerkClient: vi.fn() }));

import { createClerkClient } from '@clerk/backend';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { env } from 'hono/adapter';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport as Transport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { generateProtectedResourceMetadata } from '../server';

import {
  McpAuthError,
  type McpAuthFailure,
  McpTokenVerificationError,
  protectedResourceMetadataHandler,
  authorizationServerMetadataHandler,
  mcpAuth,
  streamableHttpHandler,
} from './index';

const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
const BARE_CHALLENGE =
  'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"';
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

describe('protectedResourceMetadataHandler', () => {
  beforeEach(() => {
    vi.mocked(env).mockImplementation(() => process.env);
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  });

  test('derives auth server URL from CLERK_PUBLISHABLE_KEY', async () => {
    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler());

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorization_servers).toEqual(['https://clerk.example.com']);
    expect(json.resource).toBe('http://myapp.com');
  });

  test('merges additional properties', async () => {
    const app = new Hono();
    app.get(
      '/.well-known/oauth-protected-resource',
      protectedResourceMetadataHandler({ properties: { scopes_supported: ['read', 'write'] } }),
    );

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    const json = await res.json();
    expect(json.scopes_supported).toEqual(['read', 'write']);
  });

  test('works in edge runtimes without Node.js Buffer', () => {
    const metadata = (() => {
      vi.stubGlobal('Buffer', undefined);
      try {
        return generateProtectedResourceMetadata({
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
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler());

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorization_servers).toEqual(['https://clerk.example.com']);
  });

  test('returns 500 when CLERK_PUBLISHABLE_KEY is missing', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler());

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    expect(res.status).toBe(500);
  });
});

describe('authorizationServerMetadataHandler', () => {
  beforeEach(() => {
    vi.mocked(env).mockImplementation(() => process.env);
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  });

  test('returns fetched Clerk metadata', async () => {
    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());

    const res = await app.request('http://myapp.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issuer).toBe('https://clerk.example.com');
  });

  test('reads CLERK_PUBLISHABLE_KEY through Hono adapter env', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    vi.mocked(env).mockReturnValue({ CLERK_PUBLISHABLE_KEY: FAKE_PK });

    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());

    const res = await app.request('http://myapp.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issuer).toBe('https://clerk.example.com');
  });

  test('returns 500 when CLERK_PUBLISHABLE_KEY is missing', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());

    const res = await app.request('http://myapp.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(500);
  });
});

describe('mcpAuth', () => {
  const reject = async () => undefined;

  test.each([
    ['mcpAuth(verifyToken)', () => (mcpAuth as (...args: unknown[]) => unknown)(reject)],
    [
      'mcpAuth(verifyToken, options)',
      () =>
        (mcpAuth as (...args: unknown[]) => unknown)(reject, {
          resourceUrl: 'https://mcp.example.com/mcp',
        }),
    ],
  ])('throws a Clerk error naming the options form for %s', (_form, call) => {
    expect(call).toThrow('Clerk error: mcpAuth takes an options object');
    expect(call).toThrow('mcpAuth({ verifyToken })');
  });

  test.each([['https://mcp.example.com/mcp'], [undefined]])(
    'calls verifyToken with the token and the context instead of Clerk (resourceUrl: %j)',
    async (resourceUrl) => {
      const verifyToken = vi.fn(async (token: string, c: Context) => ({
        token,
        scopes: [],
        clientId: c.req.path,
      }));
      const app = new Hono();
      app.post('/mcp', mcpAuth({ verifyToken, resourceUrl }), (c) => c.json(c.get('mcpAuth')));

      const res = await app.request('https://mcp.example.com/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer my-token' },
      });

      expect(res.status).toBe(200);
      expect(verifyToken).toHaveBeenCalledOnce();
      expect(verifyToken.mock.calls[0]?.[0]).toBe('my-token');
      expect(verifyToken.mock.calls[0]?.[1].req.path).toBe('/mcp');
      expect(await res.json()).toEqual({
        token: 'my-token',
        scopes: [],
        clientId: '/mcp',
        resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
      });
    },
  );

  test('returns 401 with WWW-Authenticate when Authorization header is missing', async () => {
    const app = new Hono();
    app.get('/mcp', mcpAuth({ verifyToken: async () => undefined }), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp');
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toBe(BARE_CHALLENGE);
  });

  test('returns 401 when verifyToken returns undefined', async () => {
    const app = new Hono();
    app.get('/mcp', mcpAuth({ verifyToken: async () => undefined }), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer bad-token' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`${BARE_CHALLENGE}, error="invalid_token"`);
  });

  test('returns 403 with the granted and missing scopes when requiredScopes are missing', async () => {
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth({
        verifyToken: async () => ({ token: 't', scopes: ['openid'], clientId: 'c' }),
        requiredScopes: ['profile', 'email'],
      }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `${BARE_CHALLENGE}, error="insufficient_scope", scope="openid profile email"`,
    );
  });

  test('allows a token that has every required scope', async () => {
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth({
        verifyToken: async () => ({ token: 't', scopes: ['profile', 'email'], clientId: 'c' }),
        requiredScopes: ['profile', 'email'],
      }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
  });

  test('derives resource_metadata from resourceUrl instead of the request', async () => {
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth({ verifyToken: async () => undefined, resourceUrl: 'https://mcp.example.com/mcp' }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://internal:3000/mcp');

    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('throws at setup for an invalid resourceUrl or scope', () => {
    for (const resourceUrl of [
      '/mcp',
      'mailto:foo@example.com',
      'https://user:pass@mcp.example.com/mcp',
    ]) {
      expect(() => mcpAuth({ verifyToken: async () => undefined, resourceUrl })).toThrow(
        'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL without credentials',
      );
    }
    expect(() => mcpAuth({ verifyToken: async () => undefined, requiredScopes: ['a b'] })).toThrow(
      'Clerk error: mcpAuth requiredScopes must contain only scope tokens',
    );
    expect(() => mcpAuth({ verifyToken: async () => undefined, challengeScopes: ['a"b'] })).toThrow(
      'Clerk error: mcpAuth challengeScopes must contain only scope tokens',
    );
  });

  test.each([
    ['a missing header', undefined, BARE_CHALLENGE],
    ['a rejected token', 'Bearer bad-token', `${BARE_CHALLENGE}, error="invalid_token"`],
  ])(
    'lists requiredScopes then challengeScopes in the 401 challenge for %s',
    async (_, authorization, challenge) => {
      const app = new Hono();
      app.get(
        '/mcp',
        mcpAuth({
          verifyToken: async () => undefined,
          requiredScopes: ['profile'],
          challengeScopes: ['email', 'profile', 'org:read'],
        }),
        (c) => c.json({ ok: true }),
      );

      const res = await app.request('http://localhost/mcp', {
        headers: authorization ? { Authorization: authorization } : {},
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        `${challenge}, scope="profile email org:read"`,
      );
    },
  );

  test('does not require challengeScopes of a token', async () => {
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth({
        verifyToken: async () => ({ token: 't', scopes: [], clientId: 'c' }),
        challengeScopes: ['email'],
      }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
  });

  test.each([
    ['missing_token', undefined, undefined],
    ['malformed_token', 'Basic t', undefined],
    ['malformed_token', 'Bearer', undefined],
    ['invalid_token', 'Bearer t', undefined],
    ['insufficient_scope', 'Bearer t', { token: 't', scopes: [], clientId: 'c' }],
  ])(
    'records %s in the mcpAuthFailure context variable',
    async (reason, authorization, authInfo) => {
      const failures: unknown[] = [];
      const app = new Hono();
      app.use(async (c, next) => {
        await next();
        failures.push(c.get('mcpAuthFailure'));
      });
      app.get(
        '/mcp',
        mcpAuth({ verifyToken: async () => authInfo, requiredScopes: ['profile'] }),
        (c) => c.json({ ok: true }),
      );

      await app.request('http://localhost/mcp', {
        headers: authorization ? { Authorization: authorization } : {},
      });

      expect(failures).toEqual([{ reason }]);
    },
  );

  test('leaves mcpAuthFailure unset for an authenticated request', async () => {
    const app = new Hono();
    app.get(
      '/mcp',
      mcpAuth({ verifyToken: async () => ({ token: 't', scopes: [], clientId: 'c' }) }),
      (c) => c.json({ failure: c.get('mcpAuthFailure') ?? null }),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer t' },
    });

    expect(await res.json()).toEqual({ failure: null });
  });

  test('throws an McpAuthError with the verifier error as its cause to onError', async () => {
    const cause = new Error('network down');
    const errors: unknown[] = [];
    const app = new Hono();
    app.onError((err, c) => {
      errors.push(err);
      return c.text('error', 500);
    });
    app.get(
      '/mcp',
      mcpAuth({
        verifyToken: async () => {
          throw cause;
        },
      }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(McpAuthError);
    expect(errors[0]).toMatchObject({ reason: 'verification_failed', cause });
  });

  test("answers an McpAuthError with a JSON server error under Hono's default error handler", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = new Hono();
    app.post(
      '/mcp',
      mcpAuth({
        verifyToken: async () => {
          throw Object.assign(new Error('unavailable'), { status: 503 });
        },
      }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: 'server_error' });
    // Hono's default handler logs errors without getResponse(); this keeps the outage visible the same way
    expect(consoleError).toHaveBeenCalledWith(expect.any(McpAuthError));
    consoleError.mockRestore();
  });

  test('gives a custom onError the McpAuthError itself, with getResponse() for the JSON answer', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: unknown[] = [];
    const app = new Hono();
    app.onError((err) => {
      errors.push(err);
      return (err as McpAuthError & { getResponse(): Response }).getResponse();
    });
    app.post(
      '/mcp',
      mcpAuth({
        verifyToken: async () => {
          throw new Error('network down');
        },
      }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(McpAuthError);
    consoleError.mockRestore();
  });

  test('rejects a token whose verifier throws an McpTokenVerificationError, with it as the cause', async () => {
    const cause = new McpTokenVerificationError('token-revoked', 'The token was revoked');
    const failures: unknown[] = [];
    const app = new Hono();
    app.use(async (c, next) => {
      await next();
      failures.push(c.get('mcpAuthFailure'));
    });
    app.get(
      '/mcp',
      mcpAuth({
        verifyToken: async () => {
          throw cause;
        },
      }),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    expect(await res.text()).not.toContain('revoked');
    expect(failures).toEqual([{ reason: 'invalid_token', cause }]);
  });

  test('calls next and stores authInfo in context when token is valid', async () => {
    const authInfo: AuthInfo = {
      token: 'valid',
      scopes: ['read'],
      clientId: 'client-1',
      extra: { userId: 'user-1' },
    };
    const app = new Hono();
    app.get('/mcp', mcpAuth({ verifyToken: async () => authInfo }), (c) =>
      c.json(c.get('mcpAuth')),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer valid' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...authInfo,
      resourceMetadataUrl: 'http://localhost/.well-known/oauth-protected-resource/mcp',
    });
  });

  test('returns 401 when Authorization header has no token value', async () => {
    const app = new Hono();
    app.get('/mcp', mcpAuth({ verifyToken: async () => undefined }), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer' },
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toBe(BARE_CHALLENGE);
  });

  test('returns 401 and does not verify when Authorization scheme is not Bearer', async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      token: 'valid',
      scopes: ['read'],
      clientId: 'client-1',
    });
    const app = new Hono();
    app.get('/mcp', mcpAuth({ verifyToken }), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Basic valid' },
    });

    expect(res.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
  });

  test('returns 401 and does not verify when Bearer header has extra parts', async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      token: 'valid',
      scopes: ['read'],
      clientId: 'client-1',
    });
    const app = new Hono();
    app.get('/mcp', mcpAuth({ verifyToken }), (c) => c.json({ ok: true }));

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer valid extra' },
    });

    expect(res.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
  });
});

describe('mcpAuth with Clerk', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  const clerk = { authenticateRequest: vi.fn() };

  function clerkApp() {
    const app = new Hono();
    app.post(
      '/mcp',
      mcpAuth({ resourceUrl, requiredScopes: ['profile'], clerkClient: clerk as never }),
      (c) => c.json(c.get('mcpAuth')),
    );
    return app;
  }

  const post = (app: Hono) =>
    app.request('http://internal/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });

  beforeEach(() => {
    clerk.authenticateRequest.mockReset();
  });

  afterEach(() => {
    vi.mocked(env).mockImplementation(() => process.env);
  });

  test('asks Clerk to check the audience and passes the auth info on', async () => {
    clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({
        isAuthenticated: true,
        tokenType: 'oauth_token',
        id: 'oat_1',
        subject: 'user-1',
        getToken: async () => 'token',
        clientId: 'client-1',
        scopes: ['profile'],
        userId: 'user-1',
      }),
    });

    const res = await post(clerkApp());

    expect(res.status).toBe(200);
    const [request, options] = clerk.authenticateRequest.mock.calls[0]!;
    expect(request.headers.get('authorization')).toBe('Bearer token-1');
    expect(options).toEqual({ acceptsToken: 'oauth_token', audience: resourceUrl });
    expect(await res.json()).toMatchObject({ clientId: 'client-1', token: 'token-1' });
  });

  function listedApp() {
    const app = new Hono();
    app.use(async (c, next) => {
      await next();
      const failure = c.get('mcpAuthFailure');
      if (failure) c.header('X-Failure', failure.reason);
    });
    app.post(
      '/mcp',
      mcpAuth({
        resourceUrl: ['https://a.example.com/mcp', 'https://b.example.com/mcp'],
        clerkClient: clerk as never,
      }),
      (c) => c.json({ ok: true }),
    );
    return app;
  }

  test('checks the audience and challenge against the listed resourceUrl with the request origin', async () => {
    clerk.authenticateRequest.mockResolvedValue({ isAuthenticated: false });
    const app = listedApp();

    for (const origin of ['https://a.example.com', 'https://b.example.com']) {
      clerk.authenticateRequest.mockClear();
      const res = await app.request(`${origin}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token-1' },
      });

      expect(clerk.authenticateRequest.mock.calls[0]![1]).toMatchObject({
        audience: `${origin}/mcp`,
      });
      expect(res.headers.get('WWW-Authenticate')).toBe(
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
      );
    }
  });

  test('answers a request to an unlisted origin with a 421 and records why', async () => {
    const res = await listedApp().request('https://evil.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });

    expect(res.status).toBe(421);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    expect(res.headers.get('X-Failure')).toBe('misdirected_request');
    expect(clerk.authenticateRequest).not.toHaveBeenCalled();
  });

  test('throws at setup for an empty list or two URLs with one origin', () => {
    expect(() => mcpAuth({ resourceUrl: [], clerkClient: clerk as never })).toThrow(
      'Clerk error: mcpAuth resourceUrl must be a URL or a non-empty list of URLs',
    );
    expect(() =>
      mcpAuth({
        resourceUrl: ['https://a.example.com/mcp', 'https://a.example.com/other'],
        clerkClient: clerk as never,
      }),
    ).toThrow('Clerk error: mcpAuth resourceUrl lists more than one URL for https://a.example.com');
  });

  test('answers a rejected token with the invalid_token challenge', async () => {
    clerk.authenticateRequest.mockResolvedValue({ isAuthenticated: false });

    const res = await post(clerkApp());

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", scope="profile"',
    );
  });

  test('records what Clerk reported for a rejected token without sending it to the client', async () => {
    clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      reason: 'token-verification-failed',
      message: 'JWT is expired. (code=token-verification-failed, status=n/a)',
    });
    const failures: unknown[] = [];
    const app = new Hono();
    app.use(async (c, next) => {
      await next();
      failures.push(c.get('mcpAuthFailure'));
    });
    app.post('/mcp', mcpAuth({ resourceUrl, clerkClient: clerk as never }), (c) =>
      c.json({ ok: true }),
    );

    const res = await post(app);

    const [failure] = failures as McpAuthFailure[];
    expect(failure?.reason).toBe('invalid_token');
    expect(failure?.cause).toBeInstanceOf(McpTokenVerificationError);
    expect(failure?.cause).toMatchObject({
      code: 'token-verification-failed',
      message: 'JWT is expired. (code=token-verification-failed, status=n/a)',
    });
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    );
    expect(await res.text()).not.toContain('expired');
  });

  test.each(['unexpected-error', 'secret-key-invalid'])(
    'answers a %s verification failure with a 500 instead of a challenge',
    async (reason) => {
      clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
        reason,
        message: 'Unexpected error',
      });
      const errors: unknown[] = [];
      const app = clerkApp();
      app.onError((err, c) => {
        errors.push(err);
        return c.text('error', 500);
      });

      const res = await post(app);

      expect(res.status).toBe(500);
      expect(res.headers.get('WWW-Authenticate')).toBeNull();
      expect(errors[0]).toBeInstanceOf(McpAuthError);
      const { cause } = errors[0] as McpAuthError;
      expect(cause).toBeInstanceOf(McpTokenVerificationError);
      expect(cause).toMatchObject({ code: reason, message: 'Unexpected error' });
    },
  );

  test('answers a thrown verification error with a 500 instead of a challenge', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clerk.authenticateRequest.mockRejectedValue(new Error('network down'));

    const res = await post(clerkApp());

    expect(res.status).toBe(500);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    consoleError.mockRestore();
  });

  test('fails loudly when passed to a route without being called', async () => {
    const app = new Hono();
    let error: unknown;
    app.onError((err, c) => {
      error = err;
      return c.text('error', 500);
    });
    app.post('/mcp', mcpAuth as unknown as MiddlewareHandler, (c) => c.json({ ok: true }));

    const res = await post(app);

    expect(res.status).toBe(500);
    expect(String(error)).toContain('Clerk error: mcpAuth needs a resourceUrl');
  });

  test('verifies with the clerkClient option without clerkMiddleware', async () => {
    const authenticateRequest = vi.fn().mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({
        isAuthenticated: true,
        tokenType: 'oauth_token',
        id: 'oat_1',
        subject: 'user-1',
        getToken: async () => 'token',
        clientId: 'client-1',
        scopes: [],
        userId: 'user-1',
      }),
    });
    const app = new Hono();
    app.post('/mcp', mcpAuth({ resourceUrl, clerkClient: { authenticateRequest } as never }), (c) =>
      c.json(c.get('mcpAuth')),
    );

    const res = await post(app);

    expect(res.status).toBe(200);
    expect(authenticateRequest).toHaveBeenCalledOnce();
    expect(clerk.authenticateRequest).not.toHaveBeenCalled();
  });

  // A setup mistake is thrown as it is, not as the cause of an `McpAuthError`, and before any token arrives
  test.each([
    ['with a token', { authorization: 'Bearer token' }],
    ['without a token', undefined],
  ])(
    'throws the Clerk error itself %s when there is no clerkClient and no keys are set',
    async (_case, headers) => {
      vi.mocked(env).mockReturnValue({});
      const app = new Hono();
      let error: unknown;
      app.onError((err, c) => {
        error = err;
        return c.text('error', 500);
      });
      app.post('/mcp', mcpAuth({ resourceUrl }), (c) => c.json({ ok: true }));

      const res = await app.request(resourceUrl, { method: 'POST', headers });

      expect(res.status).toBe(500);
      expect(error).not.toBeInstanceOf(McpAuthError);
      expect((error as Error).message).toBe(
        'Clerk error: mcpAuth needs the CLERK_SECRET_KEY environment variable or a clerkClient option',
      );
    },
  );

  test('needs no Clerk client with verifyToken', async () => {
    const app = new Hono();
    app.post('/mcp', mcpAuth({ verifyToken: async () => undefined }), (c) => c.json({ ok: true }));

    const res = await app.request(resourceUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    });

    expect(res.status).toBe(401);
  });
});

describe('mcpAuth with a Clerk client built from the environment', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  const authenticated = {
    isAuthenticated: true,
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: 'oauth_token',
      id: 'oat_1',
      subject: 'user-1',
      getToken: async () => 'token',
      clientId: 'client-1',
      scopes: [],
      userId: 'user-1',
    }),
  };

  // Each test uses its own key pair, since the client built for a pair is kept for the life of the module
  const keys = (n: number) => ({
    CLERK_SECRET_KEY: `sk_test_${n}`,
    CLERK_PUBLISHABLE_KEY: `${FAKE_PK}${n}`,
  });

  function envClient() {
    const client = { authenticateRequest: vi.fn().mockResolvedValue(authenticated) };
    vi.mocked(createClerkClient).mockReturnValue(client as never);
    return client;
  }

  function envApp(options: Parameters<typeof mcpAuth>[0] = { resourceUrl }) {
    const app = new Hono();
    app.post('/mcp', mcpAuth(options), (c) => c.json(c.get('mcpAuth')));
    return app;
  }

  const post = (app: Hono) =>
    app.request(resourceUrl, { method: 'POST', headers: { Authorization: 'Bearer token-1' } });

  beforeEach(() => {
    vi.mocked(createClerkClient).mockReset();
  });

  afterEach(() => {
    vi.mocked(env).mockImplementation(() => process.env);
  });

  test('verifies with a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY, once per request', async () => {
    vi.mocked(env).mockReturnValue(keys(1));
    const client = envClient();

    const res = await post(envApp());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ clientId: 'client-1', token: 'token-1' });
    expect(createClerkClient).toHaveBeenCalledExactlyOnceWith({
      secretKey: 'sk_test_1',
      publishableKey: `${FAKE_PK}1`,
    });
    expect(client.authenticateRequest).toHaveBeenCalledOnce();
    expect(client.authenticateRequest.mock.calls[0]![1]).toEqual({
      acceptsToken: 'oauth_token',
      audience: resourceUrl,
    });
  });

  test('reuses the client across requests with the same keys and builds another for other keys', async () => {
    const client = envClient();
    const app = envApp();

    vi.mocked(env).mockReturnValue(keys(3));
    await post(app);
    await post(app);
    vi.mocked(env).mockReturnValue(keys(4));
    await post(app);

    expect(vi.mocked(createClerkClient).mock.calls).toEqual([
      [{ secretKey: 'sk_test_3', publishableKey: `${FAKE_PK}3` }],
      [{ secretKey: 'sk_test_4', publishableKey: `${FAKE_PK}4` }],
    ]);
    expect(client.authenticateRequest).toHaveBeenCalledTimes(3);
  });

  test('throws a Clerk error asking to install @clerk/backend, with the load error as the cause, when it cannot be loaded', async () => {
    const loadError = new Error('Cannot find package @clerk/backend');
    vi.resetModules();
    vi.doMock('@clerk/backend', () => {
      throw loadError;
    });
    Object.assign(process.env, keys(6));
    try {
      const { mcpAuth: freshMcpAuth } = await import('./index');
      let error: unknown;
      const app = new Hono();
      app.onError((err, c) => {
        error = err;
        return c.text('error', 500);
      });
      app.post('/mcp', freshMcpAuth({ resourceUrl }), (c) => c.json({ ok: true }));

      const res = await post(app);

      expect(res.status).toBe(500);
      expect((error as Error).message).toBe(
        'Clerk error: install @clerk/backend, or pass clerkClient to mcpAuth',
      );
      // Vitest wraps an error thrown by a mock factory in its own, with the original as that error's cause
      const { cause } = error as Error;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).cause).toBe(loadError);
    } finally {
      delete process.env.CLERK_SECRET_KEY;
      delete process.env.CLERK_PUBLISHABLE_KEY;
      // Back to the mock the other tests use, which later imports of `@clerk/backend` load again
      vi.doMock('@clerk/backend', () => ({ createClerkClient }));
      vi.resetModules();
    }
  });

  test('throws a Clerk error naming CLERK_PUBLISHABLE_KEY when only it is missing', async () => {
    vi.mocked(env).mockReturnValue({ CLERK_SECRET_KEY: 'sk_test_2' });
    let error: unknown;
    const app = envApp();
    app.onError((err, c) => {
      error = err;
      return c.text('error', 500);
    });

    const res = await post(app);

    expect(res.status).toBe(500);
    expect((error as Error).message).toBe(
      'Clerk error: mcpAuth needs the CLERK_PUBLISHABLE_KEY environment variable or a clerkClient option',
    );
    expect(createClerkClient).not.toHaveBeenCalled();
  });
});

describe('streamableHttpHandler', () => {
  test('throws at setup when given a server object instead of a factory', () => {
    // @ts-expect-error a shared server object is not accepted
    expect(() => streamableHttpHandler(createMcpServer(), Transport)).toThrow(
      'Clerk error: streamableHttpHandler needs a function that returns a new MCP server as its first argument, so each request gets its own server. Call streamableHttpHandler(() => new McpServer(...), WebStandardStreamableHTTPServerTransport) instead of passing a server object',
    );
  });

  test('throws at setup without the transport class', () => {
    // @ts-expect-error the transport class is required
    expect(() => streamableHttpHandler(createMcpServer)).toThrow(
      "Clerk error: streamableHttpHandler needs the MCP SDK transport class as its second argument. Import WebStandardStreamableHTTPServerTransport from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'",
    );
  });

  test('handles an MCP initialize request and returns 200', async () => {
    const app = new Hono();
    app.post('/mcp', streamableHttpHandler(createMcpServer, Transport));

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    });

    expect(res.status).toBe(200);
    await res.text();
  });

  test.each(['GET', 'DELETE'])(
    'answers a %s with a 405 and Allow: POST, without building a server',
    async (method) => {
      const createServer = vi.fn(createMcpServer);
      const app = new Hono();
      app.all('/mcp', streamableHttpHandler(createServer, Transport));

      const res = await app.request('http://localhost/mcp', { method, headers: mcpHeaders });

      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
      expect(createServer).not.toHaveBeenCalled();
    },
  );

  test.each(['json', 'text'] as const)(
    'body handoff recovers cached %s for the SDK 1 transport and preserves Request metadata',
    async (reader) => {
      const handleRequest = vi.spyOn(Transport.prototype, 'handleRequest');
      const abort = new AbortController();
      try {
        const app = new Hono();
        app.use('/mcp', async (c, next) => {
          await c.req[reader]();
          await next();
        });
        app.post('/mcp', streamableHttpHandler(createMcpServer, Transport));

        const request = new Request('http://localhost/mcp?test=body', {
          method: 'POST',
          headers: mcpHeaders,
          body: initializeBody,
          credentials: 'include',
          redirect: 'manual',
          signal: abort.signal,
        });
        const response = await app.fetch(request);
        expect(response.status).toBe(200);
        await response.text();

        const forwarded = handleRequest.mock.calls[0]![0];
        expect(forwarded.url).toBe(request.url);
        expect(forwarded.method).toBe('POST');
        expect([...forwarded.headers]).toEqual([...request.headers]);
        expect(forwarded.credentials).toBe('include');
        expect(forwarded.redirect).toBe('manual');
        abort.abort();
        expect(forwarded.signal.aborted).toBe(true);
      } finally {
        handleRequest.mockRestore();
      }
    },
  );

  test('handles sequential requests', async () => {
    const app = new Hono();
    app.post('/mcp', streamableHttpHandler(createMcpServer, Transport));

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
    app.post('/mcp', streamableHttpHandler(createServer, Transport));

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
      streamableHttpHandler(createMcpServer, Transport),
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
    app.post('/mcp', streamableHttpHandler(createMcpServer, Transport));

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
