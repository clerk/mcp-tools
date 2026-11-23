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
import { cors } from 'hono/cors';

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
  aiCatalogHandler,
  ardHandler,
  serverCardHandler,
  streamableHttpHandler,
} from './index';
import { clerkAuthenticated, expiresAt, FAKE_PK } from '../test/mcp-harness';

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

/**
 * A request shaped like @hono/node-server's lightweight request: an object on `Request.prototype` without a native
 * request's internal state, whose fields and body methods read a native request it wraps. Passing it as the input of
 * `new Request` throws, as it does on Node with `serve({ overrideGlobalObjects: false })`.
 * @param input - The URL of the wrapped request
 * @param init - The options of the wrapped request
 * @returns The lightweight request
 */
function lightweightRequest(input: string, init: RequestInit): Request {
  const native = new Request(input, init);
  const fields = [
    'url',
    'method',
    'headers',
    'body',
    'bodyUsed',
    'cache',
    'credentials',
    'integrity',
    'keepalive',
    'mode',
    'redirect',
    'referrer',
    'referrerPolicy',
    'signal',
  ] as const;
  const methods = ['arrayBuffer', 'blob', 'clone', 'formData', 'json', 'text'] as const;
  return Object.create(Request.prototype, {
    ...Object.fromEntries(fields.map((name) => [name, { get: () => native[name] }])),
    ...Object.fromEntries(methods.map((name) => [name, { value: () => native[name]() }])),
  });
}

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

  test('keeps the CORS headers a cors() middleware in front of it sets on the GET', async () => {
    const app = new Hono();
    app.use('*', cors({ origin: 'https://app.example', credentials: true }));
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler());

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource', {
      headers: { origin: 'https://app.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('cache-control')).toBe('max-age=3600');
  });

  test('returns 500 when CLERK_PUBLISHABLE_KEY is missing', async () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const app = new Hono();
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler());

    const res = await app.request('http://myapp.com/.well-known/oauth-protected-resource');
    expect(res.status).toBe(500);
  });
});

describe.each([
  [
    'serverCardHandler',
    () =>
      serverCardHandler({
        name: 'com.example/weather',
        version: '1.2.0',
        description: 'Forecasts.',
        resourceUrl: 'https://mcp.example.com/mcp',
      }),
    '/mcp/server-card',
    'application/mcp-server-card+json',
  ],
  [
    'aiCatalogHandler',
    () =>
      aiCatalogHandler({
        entries: [
          {
            identifier: 'urn:air:example.com:weather:mcp',
            displayName: 'Weather',
            url: 'https://mcp.example.com/mcp/server-card',
          },
        ],
      }),
    '/.well-known/ai-catalog.json',
    'application/ai-catalog+json',
  ],
  [
    'ardHandler',
    () =>
      ardHandler({
        entries: [
          {
            identifier: 'urn:air:example.com:weather:mcp',
            displayName: 'Weather',
            url: 'https://mcp.example.com/mcp/server-card',
          },
        ],
      }),
    '/.well-known/ard.json',
    'application/json',
  ],
])('%s', (_name, handler, path, mediaType) => {
  test('keeps the headers earlier middleware set, on the document and on a 304', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.header('x-request-id', 'r1');
      await next();
    });
    app.all(path, handler());

    const res = await app.request(`http://myapp.com${path}`);
    const notModified = await app.request(`http://myapp.com${path}`, {
      headers: { 'if-none-match': res.headers.get('etag')! },
    });

    expect(res.headers.get('x-request-id')).toBe('r1');
    expect(res.headers.get('content-type')).toBe(mediaType);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('x-request-id')).toBe('r1');
  });

  test('sends its own ETag and Cache-Control over those earlier middleware set, and revalidates against its own', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.header('ETag', '"upstream"');
      c.header('Cache-Control', 'private, max-age=60');
      await next();
    });
    app.all(path, handler());
    const own = await app.request(`http://myapp.com${path}`, { method: 'HEAD' });

    const res = await app.request(`http://myapp.com${path}`);
    const upstream = await app.request(`http://myapp.com${path}`, {
      headers: { 'if-none-match': '"upstream"' },
    });
    const notModified = await app.request(`http://myapp.com${path}`, {
      headers: { 'if-none-match': res.headers.get('etag')! },
    });
    const error = await app.request(`http://myapp.com${path}`, { method: 'POST' });

    expect(res.headers.get('etag')).toMatch(/^W\//);
    expect(res.headers.get('etag')).toBe(own.headers.get('etag'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(upstream.status).toBe(200);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('etag')).toBe(res.headers.get('etag'));
    expect(notModified.headers.get('cache-control')).toBe('public, max-age=3600');
    // An error has no validator, so it carries none
    expect(error.status).toBe(405);
    expect(error.headers.get('etag')).toBeNull();
    expect(error.headers.get('cache-control')).toBe('no-store');
  });

  test('sends the length of its own content over a Content-Length earlier middleware set', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.header('Content-Length', '4');
      await next();
    });
    app.all(path, handler());

    const res = await app.request(`http://myapp.com${path}`);
    const body = await res.text();
    const length = String(Buffer.byteLength(body));
    const head = await app.request(`http://myapp.com${path}`, { method: 'HEAD' });
    const notModified = await app.request(`http://myapp.com${path}`, {
      headers: { 'if-none-match': res.headers.get('etag')! },
    });
    const error = await app.request(`http://myapp.com${path}`, { method: 'POST' });

    expect(JSON.parse(body)).toEqual(expect.any(Object));
    expect([null, length]).toContain(res.headers.get('content-length'));
    expect(head.headers.get('content-length')).toBe(length);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('content-length')).toBeNull();
    expect(error.status).toBe(405);
    expect([null, String(Buffer.byteLength(await error.text()))]).toContain(
      error.headers.get('content-length'),
    );
  });

  test('answers HEAD without a body when mounted with app.get', async () => {
    const app = new Hono();
    app.get(path, handler());

    const res = await app.request(`http://myapp.com${path}`, { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toMatch(/^W\//);
    expect(res.headers.get('content-type')).toBe(mediaType);
  });

  test('merges ETag into Quick Start CORS exposure and keeps no-store on error responses', async () => {
    const app = new Hono();
    app.use('*', cors({ origin: 'https://app.example', exposeHeaders: ['WWW-Authenticate'] }));
    app.use('*', async (c, next) => {
      c.header('Cache-Control', 'public, max-age=3600');
      await next();
    });
    app.all(path, handler());

    const res = await app.request(`http://myapp.com${path}`, {
      method: 'POST',
      headers: { origin: 'https://app.example' },
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate, ETag');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test.each([
    ['an existing case-insensitive ETag', ['etag', 'WWW-Authenticate'], 'etag,WWW-Authenticate'],
    ['a wildcard', ['*'], '*'],
  ])('does not duplicate or narrow %s in CORS exposure', async (_case, exposeHeaders, expected) => {
    const app = new Hono();
    app.use('*', cors({ origin: 'https://app.example', exposeHeaders }));
    app.all(path, handler());

    const res = await app.request(`http://myapp.com${path}`, {
      headers: { origin: 'https://app.example' },
    });

    expect(res.headers.get('access-control-expose-headers')).toBe(expected);
  });

  test('keeps the CORS headers a cors() middleware in front of it sets, as the metadata handlers do', async () => {
    const app = new Hono();
    app.use('*', cors({ origin: 'https://app.example', exposeHeaders: ['WWW-Authenticate'] }));
    app.all(path, handler());

    const res = await app.request(`http://myapp.com${path}`, {
      headers: { origin: 'https://app.example' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate, ETag');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
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

  test('rejects a non-function verifyToken at setup', () => {
    expect(() => mcpAuth({ verifyToken: null } as never)).toThrow(
      'Clerk error: mcpAuth verifyToken must be a function',
    );
  });

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
        expiresAt,
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
        expiresAt,
        resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
      });
    },
  );

  test.each([
    ['missing_token', undefined, undefined],
    ['malformed_token', 'Basic t', undefined],
    ['malformed_token', 'Bearer', undefined],
    ['invalid_token', 'Bearer t', undefined],
    ['insufficient_scope', 'Bearer t', { token: 't', scopes: [], clientId: 'c', expiresAt }],
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
        // Not discoverable, so a GET without a token gets the 401 rather than the 405
        mcpAuth({
          verifyToken: async () => authInfo,
          requiredScopes: ['profile'],
          discoverable: false,
        }),
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
      mcpAuth({ verifyToken: async () => ({ token: 't', scopes: [], clientId: 'c', expiresAt }) }),
      (c) => c.json({ failure: c.get('mcpAuthFailure') ?? null }),
    );

    const res = await app.request('http://localhost/mcp', {
      headers: { Authorization: 'Bearer t' },
    });

    expect(await res.json()).toEqual({ failure: null });
  });

  test('gives onError the McpAuthError, with the verifier error as its cause and getResponse() for the JSON answer', async () => {
    const cause = new Error('network down');
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
          throw cause;
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
    expect(errors[0]).toMatchObject({ reason: 'verification_failed', cause });
  });
});

describe('mcpAuth with Clerk', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  const clerk = { authenticateRequest: vi.fn() };

  const post = (app: Hono) =>
    app.request('http://internal/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });

  beforeEach(() => {
    clerk.authenticateRequest.mockReset();
    vi.mocked(createClerkClient).mockClear();
  });

  afterEach(() => {
    vi.mocked(env).mockImplementation(() => process.env);
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

  // A setup mistake is thrown as it is, not as the cause of an `McpAuthError`, and before any token arrives
  test.each([
    ['CLERK_SECRET_KEY', 'no keys are set, with a token', {}, { authorization: 'Bearer token' }],
    ['CLERK_SECRET_KEY', 'no keys are set, without a token', {}, undefined],
    [
      'CLERK_PUBLISHABLE_KEY',
      'only CLERK_SECRET_KEY is set',
      { CLERK_SECRET_KEY: 'sk_test_2' },
      { authorization: 'Bearer token' },
    ],
  ])(
    'throws the Clerk error itself naming %s when there is no clerkClient and %s',
    async (name, _case, keys, headers) => {
      vi.mocked(env).mockReturnValue(keys);
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
        `Clerk error: mcpAuth needs the ${name} environment variable or a clerkClient option`,
      );
      expect(createClerkClient).not.toHaveBeenCalled();
    },
  );
});

describe('mcpAuth with a Clerk client built from the environment', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  // Each test uses its own key pair, since the client built for a pair is kept for the life of the module
  const keys = (n: number) => ({
    CLERK_SECRET_KEY: `sk_test_${n}`,
    CLERK_PUBLISHABLE_KEY: `${FAKE_PK}${n}`,
  });

  function envClient() {
    const client = { authenticateRequest: vi.fn().mockResolvedValue(clerkAuthenticated()) };
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

  test('passes CLERK_API_URL, CLERK_API_VERSION, and CLERK_JWT_KEY to the client, building another when they change', async () => {
    envClient();
    const app = envApp();

    vi.mocked(env).mockReturnValue(keys(8));
    await post(app);
    vi.mocked(env).mockReturnValue({
      ...keys(8),
      CLERK_API_URL: 'https://api.clerkstage.dev',
      CLERK_API_VERSION: 'v2',
      CLERK_JWT_KEY: 'jwt-key-8',
    });
    await post(app);
    expect((await post(app)).status).toBe(200);

    expect(vi.mocked(createClerkClient).mock.calls).toEqual([
      [{ secretKey: 'sk_test_8', publishableKey: `${FAKE_PK}8` }],
      [
        {
          secretKey: 'sk_test_8',
          publishableKey: `${FAKE_PK}8`,
          apiUrl: 'https://api.clerkstage.dev',
          apiVersion: 'v2',
          jwtKey: 'jwt-key-8',
        },
      ],
    ]);
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

  // Reads the body with `reader` in a middleware, then returns the request the SDK 1 transport was handed
  async function handoff(reader: 'json' | 'text', request: Request) {
    const handleRequest = vi.spyOn(Transport.prototype, 'handleRequest');
    try {
      const app = new Hono();
      app.use('/mcp', async (c, next) => {
        await c.req[reader]();
        await next();
      });
      app.post('/mcp', streamableHttpHandler(createMcpServer, Transport));
      const response = await app.fetch(request);
      expect(response.status).toBe(200);
      await response.text();
      return handleRequest.mock.calls[0]![0];
    } finally {
      handleRequest.mockRestore();
    }
  }

  test.each(['json', 'text'] as const)(
    'body handoff recovers cached %s for the SDK 1 transport and preserves Request metadata',
    async (reader) => {
      const abort = new AbortController();
      const request = new Request('http://localhost/mcp?test=body', {
        method: 'POST',
        headers: mcpHeaders,
        body: initializeBody,
        credentials: 'include',
        redirect: 'manual',
        signal: abort.signal,
      });

      const forwarded = await handoff(reader, request);

      expect(forwarded.url).toBe(request.url);
      expect(forwarded.method).toBe('POST');
      expect([...forwarded.headers]).toEqual([...request.headers]);
      expect(forwarded.credentials).toBe('include');
      expect(forwarded.redirect).toBe('manual');
      abort.abort();
      expect(forwarded.signal.aborted).toBe(true);
    },
  );

  test.each(['json', 'text'] as const)(
    'body handoff recovers cached %s from a request that is not a native Request',
    async (reader) => {
      const request = lightweightRequest('http://localhost/mcp', {
        method: 'POST',
        headers: mcpHeaders,
        body: initializeBody,
      });
      expect(() => new Request(request)).toThrow(TypeError);

      expect((await handoff(reader, request)).url).toBe('http://localhost/mcp');
    },
  );

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
