// Rules the Express, Hono, and Next.js adapters must apply the same way, run against all three.
import express from 'express';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AddressInfo } from 'node:net';
import { type Server, request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Every adapter's default Clerk client, which an entry point given its own clerkClient must not use
const defaultClient = vi.hoisted(() => ({ authenticateRequest: vi.fn() }));
vi.mock('@clerk/express', () => ({ clerkClient: defaultClient }));
vi.mock('@clerk/backend', () => ({ createClerkClient: () => defaultClient }));
vi.mock('@clerk/nextjs/server', () => ({ clerkClient: async () => defaultClient }));

import type { AuthInfo } from './mcp-types';
import { resourceMetadataUrlFor } from './bearer-auth';
import * as expressAdapter from './express';
import * as honoAdapter from './hono';
import * as nextAdapter from './next';

const WELL_KNOWN = '/.well-known/oauth-protected-resource';
const AUTH_SERVER_PATH = '/.well-known/oauth-authorization-server';
const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
const origin = 'https://mcp.example.com';
const unlisted = ['https://other.example.dev/mcp', 'https://another.example.dev/mcp'];

beforeEach(() => {
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', FAKE_PK);
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', FAKE_PK);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  defaultClient.authenticateRequest.mockClear();
});

type Adapter = 'express' | 'hono' | 'next';
const adapterModules = { express: expressAdapter, hono: honoAdapter, next: nextAdapter };
const adapterNames = Object.keys(adapterModules) as Adapter[];

/** An Express app, or the fetch handler of a Hono app or Next.js route. */
type App = express.Express | ((request: Request) => Response | Promise<Response>);

type Init = {
  method?: string;
  authorization?: string | string[];
  body?: unknown;
  contentType?: string;
  // Sends the body as a stream, without a Content-Length
  chunked?: boolean;
};

type Answer = {
  // The origin the app saw
  origin: string;
  status: number;
  challenge: string | null;
  allow: string | null;
  headers: Headers;
  body: unknown;
};

function requestInit({ method, authorization, body, contentType, chunked }: Init): RequestInit {
  const text = body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers();
  if (text !== undefined) headers.set('content-type', contentType ?? 'application/json');
  for (const value of [authorization ?? []].flat()) headers.append('authorization', value);
  return {
    method: method ?? (text === undefined ? 'GET' : 'POST'),
    headers,
    ...(text !== undefined &&
      (chunked ? { body: new Blob([text]).stream(), duplex: 'half' } : { body: text })),
  } as RequestInit;
}

async function read(res: Response, seenOrigin: string): Promise<Answer> {
  const text = await res.text();
  return {
    origin: seenOrigin,
    status: res.status,
    challenge: res.headers.get('WWW-Authenticate'),
    allow: res.headers.get('Allow'),
    headers: res.headers,
    body: text ? JSON.parse(text) : null,
  };
}

/** Runs `send` against an Express app listening on a free port, given the app's origin. */
async function listening<T>(app: express.Express, send: (local: string) => Promise<T>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await send(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Sends one request to `path` on `app`. */
async function serve(app: App, path: string, init: Init = {}): Promise<Answer> {
  if (!('listen' in app)) {
    return read(await app(new Request(`${origin}${path}`, requestInit(init))), origin);
  }
  return listening(app, async (local) =>
    read(
      await fetch(`${local}${path}`, { ...requestInit(init), signal: AbortSignal.timeout(5000) }),
      local,
    ),
  );
}

/** Options, or a function that makes them from the origin the app sees, for options that list that origin. */
type Options = object | ((seenOrigin: string) => object);

const at = (options: Options, seenOrigin: string) =>
  typeof options === 'function' ? options(seenOrigin) : options;

/** Makes the Express handler from `options`, per request when they need the origin, which waits on the port. */
function expressHandler(
  options: Options,
  make: (options: object) => express.RequestHandler,
): express.RequestHandler {
  if (typeof options !== 'function') return make(options);
  return (req, res, next) => make(options(`http://${req.host}`))(req, res, next);
}

/** What the route behind the auth saw. */
type Reached = { reached: true; auth: AuthInfo | null; body: unknown };

/** Each adapter's auth entry point, on a route at /mcp that answers with what it saw. */
const authApps: [Adapter, (options: Options) => App][] = [
  [
    'express',
    (options) => {
      const app = express();
      app.use(express.json());
      // An app that also takes form posts on other routes, so a form-encoded body arrives parsed
      app.use(express.urlencoded());
      app.all(
        '/mcp',
        expressHandler(options, (o) => expressAdapter.mcpAuth(o as expressAdapter.McpAuthOptions)),
        (req, res) => {
          res.json({
            reached: true,
            auth: (req as express.Request & { auth?: AuthInfo }).auth ?? null,
            body: req.body ?? null,
          } satisfies Reached);
        },
      );
      return app;
    },
  ],
  [
    'hono',
    (options) => {
      // No `app.onError`: Hono's default handler answers with the error's `getResponse()`
      const app = new Hono();
      app.all(
        '/mcp',
        honoAdapter.mcpAuth(at(options, origin) as honoAdapter.McpAuthOptions),
        async (c) =>
          c.json({
            reached: true,
            auth: c.get('mcpAuth') ?? null,
            // Read after the middleware, as the MCP transport does
            body: await c.req.json().catch(() => null),
          } satisfies Reached),
      );
      return app.fetch;
    },
  ],
  [
    'next',
    (options) =>
      nextAdapter.withMcpAuth(
        async (req) =>
          Response.json({
            reached: true,
            auth: (req as Request & { auth?: AuthInfo }).auth ?? null,
            body: await req.json().catch(() => null),
          } satisfies Reached),
        at(options, origin) as nextAdapter.McpAuthOptions,
      ),
  ],
];

/** POSTs `init` to /mcp on the app `mount` makes, so a setup error rejects. */
const post = async (mount: (options: Options) => App, options: Options, init: Init = {}) =>
  serve(mount(options), '/mcp', { method: 'POST', ...init });

const protectedResourceApps: [Adapter, (options?: Options) => App][] = [
  [
    'express',
    (options = {}) => {
      const app = express();
      app.use(
        WELL_KNOWN,
        expressHandler(
          options,
          (o) =>
            expressAdapter.protectedResourceMetadataHandler(
              o as expressAdapter.ProtectedResourceMetadataOptions,
            ) as express.RequestHandler,
        ),
      );
      return app;
    },
  ],
  [
    'hono',
    (options = {}) => {
      const app = new Hono();
      app.all(
        '*',
        honoAdapter.protectedResourceMetadataHandler(
          at(options, origin) as honoAdapter.ProtectedResourceMetadataOptions,
        ),
      );
      return app.fetch;
    },
  ],
  [
    'next',
    (options = {}) => {
      const GET = nextAdapter.protectedResourceMetadataHandler(
        at(options, origin) as nextAdapter.ProtectedResourceMetadataOptions,
      );
      return (req: Request) =>
        req.method === 'OPTIONS' ? nextAdapter.metadataCorsHandler()() : GET(req);
    },
  ],
];

const authorizationServerApps: [Adapter, () => App][] = [
  [
    'express',
    () => {
      const app = express();
      app.all(AUTH_SERVER_PATH, expressAdapter.authorizationServerMetadataHandler());
      return app;
    },
  ],
  [
    'hono',
    () => {
      const app = new Hono();
      app.all('*', honoAdapter.authorizationServerMetadataHandler());
      return app.fetch;
    },
  ],
  [
    'next',
    () => {
      const GET = nextAdapter.authorizationServerMetadataHandler();
      return (req: Request) =>
        req.method === 'OPTIONS' ? nextAdapter.metadataCorsHandler()() : GET();
    },
  ],
];

/** Serves a GET to the authorization server path with `handler` as the route, and returns the error the app reported. */
async function reportedError(adapter: Adapter, handler: unknown): Promise<string> {
  let error: unknown = 'no error';
  if (adapter === 'express') {
    const app = express();
    app.get(AUTH_SERVER_PATH, handler as express.RequestHandler);
    app.use(((err, _req, res, _next) => {
      error = err;
      res.status(500).json({});
    }) satisfies express.ErrorRequestHandler);
    await serve(app, AUTH_SERVER_PATH);
  } else if (adapter === 'hono') {
    const app = new Hono();
    app.onError((err, c) => {
      error = err;
      return c.json({}, 500);
    });
    app.get(AUTH_SERVER_PATH, handler as MiddlewareHandler);
    await serve(app.fetch, AUTH_SERVER_PATH);
  } else {
    try {
      await (handler as (req: Request) => Promise<Response>)(
        new Request(`${origin}${AUTH_SERVER_PATH}`),
      );
    } catch (err) {
      error = err;
    }
  }
  return String(error);
}

describe.each(protectedResourceApps)('%s protectedResourceMetadataHandler', (_name, mount) => {
  // RFC 9728 section 3.3: the `resource` must be identical to the URL the metadata URL was derived from, so each
  // suffix maps back to the resource whose `resourceMetadataUrlFor` it is
  test.each([
    ['', ''],
    ['/mcp', '/mcp'],
    ['/mcp/', '/mcp/'],
    ['/mcp?tenant=1', '/mcp?tenant=1'],
    ['?tenant=1', '?tenant=1'],
  ])('describes the resource for the suffix %j', async (suffix, resourcePath) => {
    const res = await serve(mount(), `${WELL_KNOWN}${suffix}`);

    expect(res.status).toBe(200);
    const resource = (res.body as { resource: string }).resource;
    expect(resource).toBe(`${res.origin}${resourcePath}`);
    expect(resourceMetadataUrlFor(resource)).toBe(`${res.origin}${WELL_KNOWN}${suffix}`);
  });

  // Behind a proxy the app sees another origin than the public one, and RFC 9728 section 3.3 has the client discard
  // metadata whose `resource` is not the URL it derived the metadata URL from
  test('describes a single resourceUrl whatever origin the request has', async () => {
    const res = await serve(
      mount({ resourceUrl: 'https://public.example.com/mcp' }),
      `${WELL_KNOWN}/mcp`,
    );

    expect(res.status).toBe(200);
    expect((res.body as { resource: string }).resource).toBe('https://public.example.com/mcp');
  });

  test('describes the listed resourceUrl with the origin of the request', async () => {
    const res = await serve(
      mount((seen) => ({ resourceUrl: ['https://other.example.dev/mcp', `${seen}/mcp`] })),
      `${WELL_KNOWN}/mcp`,
    );

    expect(res.status).toBe(200);
    expect((res.body as { resource: string }).resource).toBe(`${res.origin}/mcp`);
  });

  // RFC 9110 section 15.5.20: the target URI matches no origin the server is configured for
  test('answers a request to an origin no resourceUrl lists with a 421, with CORS and no caching', async () => {
    const res = await serve(mount({ resourceUrl: unlisted }), `${WELL_KNOWN}/mcp`);

    expect(res.status).toBe(421);
    expect(res.body).toEqual({ error: 'misdirected_request' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBeNull();
  });

  test.each([
    ['clerkClient', { clerkClient: { authenticateRequest: vi.fn() } }],
    ['verifyToken', { verifyToken: vi.fn() }],
  ])('ignores the mcpAuth option %s', async (_key, verifier) => {
    const res = await serve(
      mount({
        resourceUrl: 'https://public.example.com/mcp',
        requiredScopes: ['profile'],
        ...verifier,
      }),
      `${WELL_KNOWN}/mcp`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      resource: 'https://public.example.com/mcp',
      scopes_supported: ['profile'],
    });
    for (const fn of Object.values(verifier)) {
      expect(fn instanceof Function ? fn : fn.authenticateRequest).not.toHaveBeenCalled();
    }
  });
});

// The handler takes the keys of its own adapter's `mcpAuth` options, and `onAuthFailure` is Next.js's alone
describe('protectedResourceMetadataHandler onAuthFailure', () => {
  test.each([
    ['express', expressAdapter.protectedResourceMetadataHandler],
    ['hono', honoAdapter.protectedResourceMetadataHandler],
  ])('%s throws at setup, as its mcpAuth takes no onAuthFailure', (_name, handler) => {
    // @ts-expect-error the adapter's mcpAuth options have no `onAuthFailure`
    expect(() => handler({ resourceUrl: origin, onAuthFailure: () => {} })).toThrow(
      'Clerk error: protectedResourceMetadataHandler takes an options object with resourceUrl and properties',
    );
  });

  test('next accepts it, as withMcpAuth does', () => {
    expect(() =>
      nextAdapter.protectedResourceMetadataHandler({
        resourceUrl: origin,
        onAuthFailure: () => {},
      }),
    ).not.toThrow();
  });
});

const clerkMetadata = { issuer: 'https://clerk.example.com' };

// Every adapter's metadata handlers answer with the same caching and CORS headers, so a browser-based MCP client can
// read the metadata cross-origin whichever adapter serves it.
const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};
const metadataHeaders = { ...corsHeaders, 'cache-control': 'max-age=3600' };

type HeaderCase = [Adapter, string, () => App, string];
const metadataHeaderCases: HeaderCase[] = [
  ...protectedResourceApps.map(
    ([adapter, mount]): HeaderCase => [
      adapter,
      'protectedResourceMetadataHandler',
      () => mount(),
      `${WELL_KNOWN}/mcp`,
    ],
  ),
  ...authorizationServerApps.map(
    ([adapter, mount]): HeaderCase => [
      adapter,
      'authorizationServerMetadataHandler',
      mount,
      AUTH_SERVER_PATH,
    ],
  ),
];

describe('metadata handler headers', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Answer Clerk's metadata fetch, and let the Express requests through to the local server
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      String(input).startsWith('https://clerk.example.com/')
        ? Promise.resolve(Response.json(clerkMetadata))
        : realFetch(input, init),
    );
  });

  test.each(metadataHeaderCases)(
    '%s %s sends the caching and CORS headers',
    async (_adapter, handler, mount, path) => {
      const res = await serve(mount(), path);

      expect(res.status).toBe(200);
      for (const [name, value] of Object.entries(metadataHeaders)) {
        expect(res.headers.get(name), name).toBe(value);
      }
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      if (handler === 'authorizationServerMetadataHandler') expect(res.body).toEqual(clerkMetadata);
    },
  );

  test.each(metadataHeaderCases)(
    '%s %s answers the CORS preflight',
    async (_adapter, _handler, mount, path) => {
      const res = await serve(mount(), path, { method: 'OPTIONS' });

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
      for (const [name, value] of Object.entries(corsHeaders)) {
        expect(res.headers.get(name), name).toBe(value);
      }
      expect(res.headers.get('cache-control')).toBeNull();
    },
  );

  test.each(authorizationServerApps)(
    '%s authorizationServerMetadataHandler answers a JSON 502 when Clerk metadata cannot be fetched',
    async (_adapter, mount) => {
      vi.mocked(globalThis.fetch).mockImplementation((input, init) =>
        String(input).startsWith('https://clerk.example.com/')
          ? Promise.resolve(new Response('nope', { status: 400 }))
          : realFetch(input, init),
      );
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await serve(mount(), AUTH_SERVER_PATH);

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'server_error' });
      // A failure must not be cached like the metadata is
      expect(res.headers.get('cache-control')).toBeNull();
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(String(log.mock.calls[0]?.[0])).toContain('failed with status 400');
    },
  );

  // RFC 9110 section 15.6.3: a 502 is for an invalid answer from an upstream server, and here none was asked
  test.each(adapterNames)(
    '%s authorizationServerMetadataHandler throws for a key that is not a publishable key, instead of a 502',
    async (adapter) => {
      const name =
        adapter === 'next' ? 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY' : 'CLERK_PUBLISHABLE_KEY';
      vi.stubEnv(name, 'pk_test_abc');

      const error = await reportedError(
        adapter,
        adapterModules[adapter].authorizationServerMetadataHandler(),
      );

      expect(error).toContain(`Clerk error: ${name} is not a Clerk publishable key`);
      expect(globalThis.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining('oauth-authorization-server'),
      );
    },
  );

  // 0.9.0's `authServerMetadataHandlerClerk` was passed to the route without being called, so code that only renames it
  // passes `authorizationServerMetadataHandler` itself, and the framework calls it with the request
  test.each(adapterNames)(
    '%s authorizationServerMetadataHandler passed without being called throws a Clerk error naming the fix instead of hanging',
    async (adapter) => {
      expect(
        await reportedError(adapter, adapterModules[adapter].authorizationServerMetadataHandler),
      ).toContain('Clerk error: call authorizationServerMetadataHandler() and pass its result');
    },
  );

  test('next metadataCorsHandler answers a preflight with the CORS headers', () => {
    const res = nextAdapter.metadataCorsHandler()();

    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual(corsHeaders);
  });
});

const TOKENS: Record<string, AuthInfo> = {
  'token-1': { token: 'token-1', clientId: 'client-1', scopes: ['profile'] },
  expired: {
    token: 'expired',
    clientId: 'client-1',
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) - 60,
  },
};
// A token `scoped:<scopes>` grants the comma-separated scopes, standing in for the grant a reauthorization returns.
const verifyToken = (token: string): AuthInfo | undefined => {
  const scopes = /^scoped:(.*)$/.exec(token)?.[1];
  if (scopes === undefined) return TOKENS[token];
  return { token, clientId: 'client-1', scopes: scopes.split(',').filter(Boolean) };
};

describe.each(authApps)('%s auth entry point with verifyToken', (_name, mount) => {
  test('challenges a request without a token with only resource_metadata', async () => {
    const res = await post(mount, { verifyToken });

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(`Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp"`);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  test('derives resource_metadata from resourceUrl instead of the request', async () => {
    const res = await post(mount, { verifyToken, resourceUrl: 'https://public.example.com/mcp' });

    expect(res.challenge).toBe(
      `Bearer resource_metadata="https://public.example.com${WELL_KNOWN}/mcp"`,
    );
  });

  test('derives resource_metadata from the resourceUrl listed for the request origin', async () => {
    const res = await post(mount, (seen) => ({
      verifyToken,
      resourceUrl: ['https://other.example.dev/mcp', `${seen}/mcp`],
    }));

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(`Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp"`);
  });

  // RFC 9110 section 15.5.20: the target URI matches no origin the server is configured for
  test('answers a request to an origin no resourceUrl lists with a 421', async () => {
    const res = await post(
      mount,
      { verifyToken, resourceUrl: unlisted },
      { authorization: 'Bearer token-1' },
    );

    expect(res.status).toBe(421);
    expect(res.challenge).toBeNull();
  });

  test.each(['Bearer', 'Basic abc', 'Bearer a b'])(
    'answers the malformed header %j with a 401 challenge and does not verify it',
    async (authorization) => {
      const verify = vi.fn(verifyToken);

      const res = await post(mount, { verifyToken: verify }, { authorization });

      expect(res.status).toBe(401);
      expect(res.challenge).toBe(`Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp"`);
      expect(verify).not.toHaveBeenCalled();
    },
  );

  // Two Authorization headers carry two credentials, and none of them is the one to verify
  test('challenges duplicate Authorization headers as malformed instead of verifying one of them', async () => {
    const authorization = ['Bearer token-1', 'Bearer unknown'];
    const app = mount({ verifyToken });
    // Fetch Headers join the values into one, which the Hono and Next.js adapters see. Node's http keeps only the first
    // in req.headers, so Express gets each value on its own line, which fetch cannot send.
    const res =
      'listen' in app
        ? await listening(app, async (local) => {
            const { port } = new URL(local);
            return new Promise<{ status: number; challenge: unknown }>((resolve, reject) => {
              const req = httpRequest(
                { host: '127.0.0.1', port, method: 'POST', path: '/mcp' },
                (answer) => {
                  answer.resume();
                  answer.on('end', () =>
                    resolve({
                      status: answer.statusCode ?? 0,
                      challenge: answer.headers['www-authenticate'],
                    }),
                  );
                },
              );
              req.setHeader('authorization', authorization);
              req.on('error', reject);
              req.end();
            });
          })
        : await serve(app, '/mcp', { method: 'POST', authorization });

    expect(res.status).toBe(401);
    expect(res.challenge).toMatch(/^Bearer resource_metadata="[^"]+"$/);
  });

  // RFC 6750 section 3.1
  test.each(['unknown', 'expired'])(
    'answers an %s token with the invalid_token challenge',
    async (token) => {
      const res = await post(mount, { verifyToken }, { authorization: `Bearer ${token}` });

      expect(res.status).toBe(401);
      expect(res.challenge).toBe(
        `Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp", error="invalid_token"`,
      );
    },
  );

  test('passes the auth info of a token that verifies, with its resourceMetadataUrl, to the route', async () => {
    const res = await post(mount, { verifyToken }, { authorization: 'Bearer token-1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reached: true,
      auth: { ...TOKENS['token-1'], resourceMetadataUrl: `${res.origin}${WELL_KNOWN}/mcp` },
    });
  });
});

// The Clerk branch of each adapter, given a client whose `authenticateRequest` answers with `state`
const clerkClientAnswering = (state: unknown) => ({
  authenticateRequest: vi.fn().mockResolvedValue(state),
});
const authenticatedState = {
  isAuthenticated: true,
  toAuth: () => ({
    isAuthenticated: true,
    tokenType: 'oauth_token',
    id: 'oat_1',
    subject: 'user-1',
    getToken: async () => 't',
    clientId: 'client-1',
    scopes: [],
    userId: 'user-1',
  }),
};

// How `@clerk/backend` reports a token it could not verify at all, with the status each adapter answers. With
// clerk/javascript#10826 it reports a JWKS that can't be loaded as `jwk-remote-failed-to-load`; 3.27.0 reports it as
// `token-verification-failed` with an `Error loading Clerk JWKS` message.
const unverifiable: [string, string, number][] = [
  [
    'jwk-remote-failed-to-load',
    'Error loading Clerk JWKS from https://api.clerk.com/v1/jwks with code=503 (code=jwk-remote-failed-to-load, status=n/a)',
    500,
  ],
  ['jwk-remote-failed-to-load', 'fetch failed (code=jwk-remote-failed-to-load, status=n/a)', 500],
  [
    'token-verification-failed',
    'Error loading Clerk JWKS from https://api.clerk.com/v1/jwks with code=503 (code=token-verification-failed, status=n/a)',
    500,
  ],
  ['unexpected-error', 'Unexpected error (code=unexpected-error, status=429)', 429],
  ['unexpected-error', 'Unexpected error (code=unexpected-error, status=503)', 503],
  ['unexpected-error', 'Unexpected error (code=unexpected-error, status=n/a)', 500],
  ['secret-key-invalid', 'Invalid secret key (code=secret-key-invalid, status=401)', 500],
];

// The client each adapter uses without a `clerkClient` option, as its setup error names it
const defaultClientName: Record<Adapter, string> = {
  express: "clerkClient from '@clerk/express'",
  hono: 'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY',
  next: "clerkClient from '@clerk/nextjs/server'",
};

describe.each(authApps)('%s auth entry point with Clerk', (name, mount) => {
  const send = (clerkClient: unknown, init: Init = { authorization: 'Bearer t' }) =>
    post(mount, { resourceUrl: `${origin}/mcp`, clerkClient }, init);

  test.each(unverifiable)(
    'answers %s (%s) with a JSON %i and logs the McpAuthError',
    async (reason, message, status) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await send(clerkClientAnswering({ isAuthenticated: false, reason, message }));

      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: 'server_error' });
      expect(res.challenge).toBeNull();
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[0]).toMatchObject({
        name: 'McpAuthError',
        reason: 'verification_failed',
        cause: { code: reason },
      });
    },
  );

  // RFC 6750 section 3.1: a token Clerk rejects is `invalid_token`, so the client may get a new one
  test('answers a token Clerk rejects with the invalid_token challenge', async () => {
    const res = await send(
      clerkClientAnswering({
        isAuthenticated: false,
        reason: 'token-verification-failed',
        message: 'JWT signature is invalid. (code=token-verification-failed, status=n/a)',
      }),
    );

    expect(res.status).toBe(401);
    expect(res.challenge).toContain('error="invalid_token"');
  });

  // The `clerkClient` option has one shape on every adapter: a client, or a function that returns one
  test('verifies with a client object instead of the default client', async () => {
    const client = clerkClientAnswering(authenticatedState);

    expect((await send(client)).status).toBe(200);
    expect(client.authenticateRequest).toHaveBeenCalledOnce();
    expect(defaultClient.authenticateRequest).not.toHaveBeenCalled();
  });

  test('checks the audience against the resourceUrl listed for the request origin', async () => {
    const client = clerkClientAnswering(authenticatedState);
    const res = await post(
      mount,
      (seen) => ({
        resourceUrl: ['https://other.example.dev/mcp', `${seen}/mcp`],
        clerkClient: client,
      }),
      { authorization: 'Bearer t' },
    );

    expect(res.status).toBe(200);
    expect(client.authenticateRequest.mock.calls[0]?.[1]).toMatchObject({
      audience: `${res.origin}/mcp`,
    });
  });

  test.each([
    ['with a token', 'Bearer t', 200],
    ['without a token', undefined, 401],
  ])(
    'calls a function that returns the client once per request %s',
    async (_case, authorization, status) => {
      const client = clerkClientAnswering(authenticatedState);
      const resolve = vi.fn(async () => client);

      expect((await send(resolve, { authorization })).status).toBe(status);
      expect(resolve).toHaveBeenCalledOnce();
      expect(client.authenticateRequest).toHaveBeenCalledTimes(authorization ? 1 : 0);
    },
  );

  test.each([
    ['an object without authenticateRequest', {}],
    ['null', null],
    ['a string', 'sk_test_123'],
  ])('throws at setup for %s', async (_case, clerkClient) => {
    const setup = send(clerkClient);
    await expect(setup).rejects.toThrow(
      /^Clerk error: .* takes a clerkClient with authenticateRequest, or a function that returns one\. Omit clerkClient to use /,
    );
    await expect(setup).rejects.toThrow(`Omit clerkClient to use ${defaultClientName[name]}`);
  });
});

const rpc = (method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  ...(params && { params }),
});

// `publicAccess`: what a request without a token may reach, and what it gets when it may not
describe.each(authApps)('%s publicAccess', (_name, mount) => {
  const publicAccess = { methods: true, tools: ['search_docs'] } as const;
  const send = (options: object, init: Init) => post(mount, { verifyToken, ...options }, init);

  test('lets an open method through without auth info, with its body still readable', async () => {
    const res = await send({ publicAccess }, { body: rpc('initialize') });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true, auth: null, body: rpc('initialize') });
  });

  test('lets a call to a listed tool through, and challenges a call to any other', async () => {
    const listed = await send(
      { publicAccess },
      { body: rpc('tools/call', { name: 'search_docs' }) },
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ reached: true, auth: null });

    const other = await send(
      { publicAccess, challengeScopes: ['profile', 'email'] },
      { body: rpc('tools/call', { name: 'whoami' }) },
    );
    expect(other.status).toBe(401);
    // RFC 6750 section 3.1: no error code for a request that carries no credentials
    expect(other.challenge).toMatch(
      /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp", scope="profile email"$/,
    );
    expect(other.body).toEqual({ error: 'Unauthorized' });
  });

  test('challenges JSON that was not sent as application/json', async () => {
    const res = await send(
      { publicAccess },
      { body: JSON.stringify(rpc('initialize')), contentType: 'text/plain' },
    );

    expect(res.status).toBe(401);
  });

  test('challenges a form-encoded message, even when the app parses form bodies', async () => {
    const res = await send(
      { publicAccess },
      {
        body: 'jsonrpc=2.0&id=1&method=initialize',
        contentType: 'application/x-www-form-urlencoded',
      },
    );

    expect(res.status).toBe(401);
  });

  test('answers a GET without a token with a 405 when the handshake is open', async () => {
    const res = await send({ publicAccess }, { method: 'GET' });

    expect(res.status).toBe(405);
    expect(res.allow).toBe('POST');
    expect(res.challenge).toBeNull();
    // The same body `streamableHttpHandler` sends a GET that carries a token
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });
});

// One 403 names every scope a tool needs when its scopes are in `challengeScopes`, so the client reauthorizes once
// (MCP 2026-07-28 scope challenges). Only `requiredScopes` decides whether the request gets the 403.
describe.each(authApps)('%s insufficient_scope challenge', (_name, mount) => {
  const body = rpc('tools/call', { name: 'list_projects' });
  const send = (options: object, authorization: string) =>
    post(mount, { verifyToken, ...options }, { body, authorization });

  test('lists the granted scopes, then every missing required and challenge scope, once each', async () => {
    const res = await send(
      {
        requiredScopes: ['profile', 'email'],
        challengeScopes: ['email', 'projects:read', 'profile'],
      },
      'Bearer token-1',
    );

    expect(res.status).toBe(403);
    expect(res.challenge).toMatch(
      /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp", error="insufficient_scope", scope="profile email projects:read"$/,
    );
    expect(res.body).toEqual({ error: 'insufficient_scope' });
  });

  // `email` is not first in `requiredScopes`, so list order alone would put `profile` first
  test('lists a granted scope first even when requiredScopes lists it later', async () => {
    const res = await send(
      { requiredScopes: ['profile', 'email'], challengeScopes: ['projects:read'] },
      'Bearer scoped:email',
    );

    expect(res.status).toBe(403);
    expect(res.challenge).toMatch(
      /, error="insufficient_scope", scope="email profile projects:read"$/,
    );
  });

  test('lets a token that lacks only challengeScopes entries through', async () => {
    const res = await send(
      { requiredScopes: ['profile'], challengeScopes: ['projects:read'] },
      'Bearer token-1',
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reached: true, auth: { clientId: 'client-1' } });
  });
});

describe('express publicAccess without express.json()', () => {
  function appWithoutJsonParser(options: object) {
    const app = express();
    app.post('/mcp', expressAdapter.mcpAuth({ verifyToken, ...options }), (_req, res) => {
      res.json({ reached: true });
    });
    app.use(((error, _req, res, _next) => {
      res.status(500).json({ message: (error as Error).message });
    }) satisfies express.ErrorRequestHandler);
    return app;
  }

  test('throws a setup error for a JSON request without a token, instead of a 401 with no cause', async () => {
    const res = await serve(appWithoutJsonParser({ publicAccess: { methods: true } }), '/mcp', {
      body: rpc('initialize'),
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      message:
        'Clerk error: mcpAuth publicAccess reads the parsed JSON body of the request. Mount express.json() before mcpAuth, as app.use(express.json())',
    });
  });

  test('does not need the parser without publicAccess, or for a request with a token', async () => {
    const withoutOption = await serve(appWithoutJsonParser({}), '/mcp', {
      body: rpc('initialize'),
    });
    expect(withoutOption.status).toBe(401);

    const withToken = await serve(
      appWithoutJsonParser({ publicAccess: { methods: true } }),
      '/mcp',
      { body: rpc('initialize'), authorization: 'Bearer token-1' },
    );
    expect(withToken).toMatchObject({ status: 200, body: { reached: true } });
  });
});

describe('express publicAccess behind express.json() with a limit over 1 MiB', () => {
  function app() {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.post(
      '/mcp',
      expressAdapter.mcpAuth({ verifyToken, publicAccess: { methods: ['initialize'] } }),
      (_req, res) => {
        res.json({ reached: true });
      },
    );
    return app;
  }

  test.each([
    ['a Content-Length', false],
    ['a chunked body', true],
  ])(
    'challenges an open method whose body is over 1 MiB, with %s, as the other adapters do',
    async (_case, chunked) => {
      const res = await serve(app(), '/mcp', {
        body: rpc('initialize', { padding: 'x'.repeat(2 * 1024 * 1024) }),
        chunked,
      });

      expect(res.status).toBe(401);
      expect(res.challenge).toMatch(
        /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      );
      expect(res.body).toEqual({ error: 'Unauthorized' });
    },
  );

  test.each([
    ['a Content-Length', false],
    ['a chunked body', true],
  ])('lets the same open method through with a small body, with %s', async (_case, chunked) => {
    const res = await serve(app(), '/mcp', { body: rpc('initialize'), chunked });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });
});

test('hono publicAccess throws a setup error when a middleware before it read the raw request, which leaves nothing to check', async () => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    await c.req.raw.json();
    await next();
  });
  app.post(
    '/mcp',
    honoAdapter.mcpAuth({ verifyToken, publicAccess: { methods: true, tools: ['search_docs'] } }),
    (c) => c.json({ reached: true }),
  );
  app.onError((error, c) => c.json({ message: error.message }, 500));

  const res = await serve(app.fetch, '/mcp', { body: rpc('initialize') });

  expect(res.status).toBe(500);
  expect(res.body).toEqual({
    message:
      'Clerk error: publicAccess reads the body of the request, and something before the auth check already read it. Read a copy there instead, as request.clone().json()',
  });
});
