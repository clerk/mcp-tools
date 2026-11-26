// Rules the Express, Hono, and Next.js adapters and the fetch entry must apply the same way, run against each.
import express from 'express';
import { Hono, type MiddlewareHandler } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Every adapter's default Clerk client, which an entry point given its own clerkClient must not use
const defaultClient = vi.hoisted(() => ({ authenticateRequest: vi.fn() }));
vi.mock('@clerk/express', () => ({ clerkClient: defaultClient }));
vi.mock('@clerk/backend', () => ({ createClerkClient: () => defaultClient }));
vi.mock('@clerk/nextjs/server', () => ({ clerkClient: async () => defaultClient }));
// The MCP SDK handler behind `createClerkMcpWorker` answers with what it saw, as the other entries' routes do. The
// fetch entry's own tests serve a real MCP server.
vi.mock('@modelcontextprotocol/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/server')>()),
  createMcpHandler: (factory: (context: { authInfo?: unknown }) => unknown) => ({
    fetch: async (request: Request, { authInfo }: { authInfo?: AuthInfo } = {}) => {
      await factory({ authInfo });
      return Response.json({
        reached: true,
        auth: authInfo ?? null,
        body: await request.json().catch(() => null),
      } satisfies Reached);
    },
  }),
}));

import { FAKE_PK, clerkAuthenticated, expiresAt, sendRaw, withListening } from './test/mcp-harness';
import { linkedCardCatalogErrors } from './test/ai-catalog-contract';
import { validateServerCard } from './test/server-card-schema';
import type { AuthInfo } from './mcp-types';
import { type McpAuthFailure, McpTokenVerificationError, toClerkAuthInfo } from './server';
import { resourceMetadataUrlFor } from './bearer-auth';
import { CREATE_BROWSER_SESSION_TOOL_NAME } from './create-browser-session';
import * as expressAdapter from './express';
import * as fetchEntry from './fetch';
import * as honoAdapter from './hono';
import * as nextAdapter from './next';

const WELL_KNOWN = '/.well-known/oauth-protected-resource';
const AUTH_SERVER_PATH = '/.well-known/oauth-authorization-server';
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

/** Each auth entry point: the adapters' and the fetch entry's `withClerkMcpAuth` and `createClerkMcpWorker`. */
type AuthEntry = Adapter | 'fetch' | 'fetch worker';

// The name each auth entry point's messages use
const authCaller: Record<AuthEntry, string> = {
  express: 'mcpAuth',
  hono: 'mcpAuth',
  next: 'withClerkMcpAuth',
  fetch: 'withClerkMcpAuth from @clerk/mcp-tools/fetch',
  'fetch worker': 'createClerkMcpWorker from @clerk/mcp-tools/fetch',
};

// The Worker env the fetch entry reads its Clerk keys from, and an execution context
const workerEnv = { CLERK_SECRET_KEY: 'sk_test_parity', CLERK_PUBLISHABLE_KEY: FAKE_PK };
const workerCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

/** The fetch entry's auth entry point around `handler`, as a fetch handler of the request alone. */
function fetchAuth(
  kind: 'fetch' | 'fetch worker',
  options: object,
  handler: (request: Request, authInfo: AuthInfo | undefined) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  const serveRequest =
    kind === 'fetch'
      ? fetchEntry.withClerkMcpAuth(
          (request, { authInfo }) => handler(request, authInfo),
          options as fetchEntry.McpAuthOptions,
        )
      : // The mocked SDK handler answers with what it saw, so `handler` is not called
        fetchEntry.createClerkMcpWorker({
          ...(options as fetchEntry.McpAuthOptions),
          server: () => ({}) as never,
        }).fetch;
  return (request) => serveRequest(request, workerEnv, workerCtx);
}

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

/** Sends one request to `path` on `app`. */
async function serve(app: App, path: string, init: Init = {}): Promise<Answer> {
  if (!('listen' in app)) {
    return read(await app(new Request(`${origin}${path}`, requestInit(init))), origin);
  }
  return withListening(app, async (local) =>
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
const authApps: [AuthEntry, (options: Options) => App][] = [
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
      nextAdapter.withClerkMcpAuth(
        async (req) =>
          Response.json({
            reached: true,
            auth: (req as Request & { auth?: AuthInfo }).auth ?? null,
            body: await req.json().catch(() => null),
          } satisfies Reached),
        at(options, origin) as nextAdapter.McpAuthOptions,
      ),
  ],
  ...(['fetch', 'fetch worker'] as const).map((kind): [AuthEntry, (options: Options) => App] => [
    kind,
    (options) =>
      fetchAuth(kind, at(options, origin), async (req, authInfo) =>
        Response.json({
          reached: true,
          auth: authInfo ?? null,
          body: await req.json().catch(() => null),
        } satisfies Reached),
      ),
  ]),
];

describe.each(authApps)('%s auth option validation', (name, mount) => {
  const caller = authCaller[name];

  test.each(['requiredScope', 'unknownOption', 'properties'])(
    'rejects the unknown option %s at setup',
    (key) => {
      expect(() => mount({ resourceUrl: origin, [key]: [] })).toThrow(
        `Clerk error: ${caller} has no ${key} option`,
      );
    },
  );

  test('rejects clerkClient together with verifyToken at setup', () => {
    expect(() =>
      mount({ resourceUrl: origin, clerkClient: defaultClient, verifyToken: vi.fn() }),
    ).toThrow(`Clerk error: ${caller} cannot set both clerkClient and verifyToken`);
  });

  test.each([
    ['Clerk', { clerkClient: defaultClient }],
    ['custom', { verifyToken: vi.fn() }],
  ])('accepts every shared option with the %s verifier', (_branch, verifier) => {
    expect(() =>
      mount({
        resourceUrl: origin,
        requiredScopes: ['profile'],
        challengeScopes: ['email'],
        publicAccess: { methods: ['initialize'] },
        ...verifier,
      }),
    ).not.toThrow();
  });

  test('accepts onAuthFailure only in Next.js and the fetch entry', () => {
    const setup = () => mount({ resourceUrl: origin, onAuthFailure: vi.fn() });
    if (name !== 'express' && name !== 'hono') {
      expect(setup).not.toThrow();
      return;
    }
    expect(setup).toThrow(`Clerk error: ${caller} has no onAuthFailure option`);
  });
});

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

// Fetch adapters already receive a complete URL. A conflicting Host header must not replace its authority.
describe.each(authApps.filter(([name]) => name !== 'express'))(
  '%s request URL authority',
  (_name, mount) => {
    test.each([
      ['header.example', 421],
      ['target.example', 200],
    ])('selects the URL authority with only %s listed', async (listedHost, status) => {
      const verifyToken = vi.fn(async (token: string) => ({
        token,
        clientId: 'c',
        scopes: [],
        expiresAt,
      }));
      const app = mount({ verifyToken, resourceUrl: [`https://${listedHost}/mcp`] });
      if ('listen' in app) throw new Error('Expected a fetch adapter');
      const response = await app(
        new Request('https://target.example/mcp', {
          method: 'POST',
          headers: { Host: 'header.example', Authorization: 'Bearer t' },
        }),
      );

      expect(response.status).toBe(status);
      expect(verifyToken).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      if (status === 200) expect(await response.json()).toMatchObject({ reached: true });
    });

    test('derives the challenge from the URL authority rather than Host', async () => {
      const app = mount({ verifyToken: async () => undefined });
      if ('listen' in app) throw new Error('Expected a fetch adapter');
      const response = await app(
        new Request('https://target.example/mcp?x=1', {
          method: 'POST',
          headers: { Host: 'header.example' },
        }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe(
        'Bearer resource_metadata="https://target.example/.well-known/oauth-protected-resource/mcp"',
      );
    });
  },
);

describe.each(protectedResourceApps.filter(([name]) => name !== 'express'))(
  '%s metadata URL authority',
  (_name, mount) => {
    test('derives the metadata resource from the URL authority rather than Host', async () => {
      const app = mount();
      if ('listen' in app) throw new Error('Expected a fetch adapter');
      const response = await app(
        new Request('https://target.example/.well-known/oauth-protected-resource/mcp', {
          headers: { Host: 'header.example' },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resource: 'https://target.example/mcp' });
    });
  },
);

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

/**
 * Serves a request with `handler` as the route, and returns the error the app reported.
 */
async function reportedError(
  adapter: AuthEntry,
  handler: unknown,
  path = AUTH_SERVER_PATH,
  init: Init = {},
): Promise<string> {
  let error: unknown = 'no error';
  if (adapter === 'express') {
    const app = express();
    app.all(path, handler as express.RequestHandler);
    app.use(((err, _req, res, _next) => {
      error = err;
      res.status(500).json({});
    }) satisfies express.ErrorRequestHandler);
    await serve(app, path, init);
  } else if (adapter === 'hono') {
    const app = new Hono();
    app.onError((err, c) => {
      error = err;
      return c.json({}, 500);
    });
    app.all(path, handler as MiddlewareHandler);
    await serve(app.fetch, path, init);
  } else {
    try {
      await (handler as (req: Request) => Promise<Response>)(
        new Request(`${origin}${path}`, requestInit(init)),
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

  test('next accepts it, as withClerkMcpAuth does', () => {
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
  ...protectedResourceApps.map(([adapter, mount]): HeaderCase => [
    adapter,
    'protectedResourceMetadataHandler',
    () => mount(),
    `${WELL_KNOWN}/mcp`,
  ]),
  ...authorizationServerApps.map(([adapter, mount]): HeaderCase => [
    adapter,
    'authorizationServerMetadataHandler',
    mount,
    AUTH_SERVER_PATH,
  ]),
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
  'token-1': { token: 'token-1', clientId: 'client-1', scopes: ['profile'], expiresAt },
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
  return { token, clientId: 'client-1', scopes: scopes.split(',').filter(Boolean), expiresAt };
};

/** The options `failureApps` passes to each adapter: only a `verifyToken`, which suits every adapter's request type. */
type FailureAppOptions = { verifyToken: (token: string) => AuthInfo | undefined };

/** Each adapter's auth entry point on /mcp, calling `record` with the failure it reports for a request it answers. */
const failureApps: Record<
  AuthEntry,
  (options: FailureAppOptions, record: (failure: unknown) => void) => App
> = {
  express: (options, record) => {
    const app = express();
    // The adapter sets `res.locals.mcpAuthFailure` just before it sends the answer
    app.use((_req, res, next) => {
      const json = res.json.bind(res);
      res.json = (body) => {
        record(res.locals.mcpAuthFailure);
        return json(body);
      };
      next();
    });
    app.post('/mcp', expressAdapter.mcpAuth(options), (_req, res) => {
      res.json({ reached: true });
    });
    return app;
  },
  hono: (options, record) => {
    const app = new Hono();
    app.use(async (c, next) => {
      await next();
      record(c.get('mcpAuthFailure'));
    });
    app.post('/mcp', honoAdapter.mcpAuth(options), (c) => c.json({ reached: true }));
    return app.fetch;
  },
  next: (options, record) =>
    nextAdapter.withClerkMcpAuth(async () => Response.json({ reached: true }), {
      ...options,
      onAuthFailure: record,
    }),
  fetch: (options, record) =>
    fetchAuth('fetch', { ...options, onAuthFailure: record }, () =>
      Response.json({ reached: true }),
    ),
  'fetch worker': (options, record) =>
    fetchAuth('fetch worker', { ...options, onAuthFailure: record }, () =>
      Response.json({ reached: true }),
    ),
};

/** POSTs `Bearer t` to the adapter's auth entry point with `verifyToken`, with the failure it reported. */
async function verifiedBy(adapter: AuthEntry, verifyToken: FailureAppOptions['verifyToken']) {
  let failure: McpAuthFailure | undefined;
  const app = failureApps[adapter]({ verifyToken }, (reported) => {
    failure = reported as McpAuthFailure | undefined;
  });
  const res = await serve(app, '/mcp', { method: 'POST', authorization: 'Bearer t' });
  return { ...res, failure };
}

describe.each(authApps)('%s auth entry point with verifyToken', (name, mount) => {
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
        ? await withListening(app, async (local) => {
            const raw = await sendRaw(
              local,
              `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n${authorization.map((value) => `Authorization: ${value}\r\n`).join('')}Content-Length: 0\r\nConnection: close\r\n\r\n`,
            );
            return {
              status: Number(raw.split(' ')[1]),
              challenge: /^WWW-Authenticate: (.*)$/im.exec(raw)?.[1]?.trim(),
            };
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

  // OAuth 2.1 section 5.2, which MCP authorization 2025-06-18 and later points to: the resource server MUST check that
  // the token is not expired, which a result without an expiry can't show. RFC 9068 section 2.2 makes `exp` and
  // `client_id` REQUIRED in a JWT access token. The messages follow MCP SDK's `requireBearerAuth`.
  const issued = { token: 't', clientId: 'client-1', scopes: [], expiresAt };
  test.each([
    ['no expiresAt', { expiresAt: undefined }, 'Token has no expiration time (expiresAt)'],
    [
      'a NaN expiresAt',
      { expiresAt: Number.NaN },
      'Token has no valid expiration time (expiresAt: NaN)',
    ],
    ['an empty clientId', { clientId: '' }, 'Token has no client ID (clientId)'],
    ['no clientId', { clientId: undefined }, 'Token has no client ID (clientId)'],
  ])(
    'answers a result with %s with the invalid_token challenge',
    async (_case, fields, message) => {
      const res = await verifiedBy(name, () => ({ ...issued, ...fields }) as AuthInfo);

      expect(res.status).toBe(401);
      expect(res.challenge).toBe(
        `Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp", error="invalid_token"`,
      );
      expect(res.failure).toMatchObject({
        reason: 'invalid_token',
        cause: { code: 'token-claims-missing', message },
      });
    },
  );

  test.each([
    ['no expiresAt', { expiresAt: undefined }],
    ['an empty clientId', { clientId: '' }],
  ])('rejects a forged Clerk marker with %s', async (_name, fields) => {
    const res = await verifiedBy(name, () => ({
      ...issued,
      ...fields,
      extra: { userId: 'user-1', verifiedBy: 'clerk' },
    }));

    expect(res.status).toBe(401);
    expect(res.challenge).toContain('error="invalid_token"');
    expect(res.failure).toMatchObject({
      reason: 'invalid_token',
      cause: { code: 'token-claims-missing' },
    });
  });

  test('rejects serialized cached Clerk auth info without an expiry', async () => {
    const verified = toClerkAuthInfo(clerkAuthenticated().toAuth(), 't');
    const cached = JSON.parse(JSON.stringify(verified)) as AuthInfo;

    const res = await verifiedBy(name, () => cached);

    expect(res.status).toBe(401);
    expect(res.challenge).toContain('error="invalid_token"');
    expect(res.failure).toMatchObject({
      reason: 'invalid_token',
      cause: { code: 'token-claims-missing', message: 'Token has no expiration time (expiresAt)' },
    });
  });

  test('rejects expired cached Clerk auth info even with private provenance', async () => {
    const cached = toClerkAuthInfo(clerkAuthenticated().toAuth(), 't')!;
    cached.expiresAt = Math.floor(Date.now() / 1000) - 60;

    const res = await verifiedBy(name, () => cached);

    expect(res.status).toBe(401);
    expect(res.challenge).toContain('error="invalid_token"');
    expect(res.failure).toMatchObject({
      reason: 'invalid_token',
      cause: { code: 'token-expired' },
    });
  });

  // Clerk enforces `exp` itself, so auth info from `toClerkAuthInfo` in a custom verifier needs no `expiresAt`
  test('passes auth info a custom verifier built with toClerkAuthInfo, without an expiresAt', async () => {
    const authInfo = toClerkAuthInfo(clerkAuthenticated().toAuth(), 't');

    const res = await verifiedBy(name, () => authInfo);

    expect(authInfo?.expiresAt).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.failure).toBeUndefined();
  });

  // What the READMEs tell verifier authors: a library error the verifier lets escape, such as jose's `JWTExpired`,
  // means the token could not be verified at all, so it gets the server error, which keeps the client's token
  test.each([
    [
      "jose's JWTExpired",
      Object.assign(new Error('"exp" claim timestamp check failed'), {
        name: 'JWTExpired',
        code: 'ERR_JWT_EXPIRED',
      }),
      500,
    ],
    [
      'an error with a 503 status',
      Object.assign(new Error('JWKS unavailable'), { status: 503 }),
      503,
    ],
  ])(
    'answers a verifier that throws %s with a JSON %i and logs the McpAuthError',
    async (_case, error, status) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await verifiedBy(name, () => {
        throw error;
      });

      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: 'server_error' });
      expect(res.challenge).toBeNull();
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[0]).toMatchObject({
        name: 'McpAuthError',
        reason: 'verification_failed',
        cause: error,
      });
    },
  );

  // RFC 6750 section 3.1: an expired token is `invalid_token`, which the resource SHOULD answer with a 401
  test('answers a verifier that throws an McpTokenVerificationError with the invalid_token challenge', async () => {
    const rejection = new McpTokenVerificationError('token-expired', 'The token expired');

    const res = await verifiedBy(name, () => {
      throw rejection;
    });

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp", error="invalid_token"`,
    );
    expect(res.failure).toMatchObject({ reason: 'invalid_token', cause: rejection });
  });
});

// The Clerk branch of each adapter, given a client whose `authenticateRequest` answers with `state`
const clerkClientAnswering = (state: unknown) => ({
  authenticateRequest: vi.fn().mockResolvedValue(state),
});
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
const defaultClientName: Record<AuthEntry, string> = {
  express: "clerkClient from '@clerk/express'",
  hono: 'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY',
  next: "clerkClient from '@clerk/nextjs/server'",
  fetch: 'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY in the Worker env',
  'fetch worker':
    'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY in the Worker env',
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
    const client = clerkClientAnswering(clerkAuthenticated());

    const res = await send(client);

    expect(res.status).toBe(200);
    expect(client.authenticateRequest).toHaveBeenCalledOnce();
    expect(client.authenticateRequest.mock.calls[0]?.[0].headers.get('authorization')).toBe(
      'Bearer t',
    );
    expect(defaultClient.authenticateRequest).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      auth: {
        clientId: 'client-1',
        extra: { userId: 'user-1', verifiedBy: 'clerk' },
        resourceMetadataUrl: `${origin}${WELL_KNOWN}/mcp`,
      },
    });
  });

  test('checks the audience against the resourceUrl listed for the request origin', async () => {
    const client = clerkClientAnswering(clerkAuthenticated());
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

  // Clerk lowercases the scheme and host of the client's `resource` but keeps a default port when it builds `aud`
  test('accepts a token whose audience is the resourceUrl with only its scheme and host lowercased', async () => {
    const aud = 'https://mcp.example.com:443/mcp';
    const client = {
      authenticateRequest: vi.fn(
        async (_req: Request, { audience }: { audience: string | string[] }) =>
          [audience].flat().includes(aud)
            ? clerkAuthenticated()
            : {
                isAuthenticated: false,
                reason: 'token-verification-failed',
                message:
                  'Invalid JWT audience claim (aud). (code=token-verification-failed, status=n/a)',
              },
      ),
    };

    const res = await post(
      mount,
      { resourceUrl: 'https://MCP.example.com:443/mcp', clerkClient: client },
      { authorization: 'Bearer t' },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ auth: { clientId: 'client-1' } });
  });

  test.each([
    [
      'https://MCP.example.com:443/mcp',
      [
        'https://MCP.example.com:443/mcp',
        'https://mcp.example.com/mcp',
        'https://mcp.example.com:443/mcp',
      ],
    ],
    ['https://mcp.example.com', ['https://mcp.example.com', 'https://mcp.example.com/']],
    // The root's protected resource metadata describes the bare origin, so a client can send that form back
    ['https://mcp.example.com/', ['https://mcp.example.com/', 'https://mcp.example.com']],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp'],
  ])(
    'checks the audience of %s against each distinct form of it',
    async (resourceUrl, audience) => {
      const client = clerkClientAnswering(clerkAuthenticated());

      const res = await post(
        mount,
        { resourceUrl, clerkClient: client },
        { authorization: 'Bearer t' },
      );

      expect(res.status).toBe(200);
      expect(client.authenticateRequest.mock.calls[0]?.[1]).toEqual({
        acceptsToken: 'oauth_token',
        audience,
      });
    },
  );

  test.each([
    ['with a token', 'Bearer t', 200],
    ['without a token', undefined, 401],
  ])(
    'calls a function that returns the client once per request %s',
    async (_case, authorization, status) => {
      const client = clerkClientAnswering(clerkAuthenticated());
      const resolve = vi.fn(async () => client);

      expect((await send(resolve, { authorization })).status).toBe(status);
      expect(resolve).toHaveBeenCalledOnce();
      expect(client.authenticateRequest).toHaveBeenCalledTimes(authorization ? 1 : 0);
    },
  );

  describe.each([
    ['synchronous', (client: unknown) => () => client],
    ['asynchronous', (client: unknown) => async () => client],
  ] as const)('%s client resolver', (_kind, resolverFor) => {
    test.each([
      ['an object without authenticateRequest', {}],
      ['null', null],
      ['undefined', undefined],
      ['a string', 'sk_test_123'],
      ['a non-callable authenticateRequest', { authenticateRequest: true }],
    ])(
      'reports the setup error for %s before checking any token or public access',
      async (_case, client) => {
        const resolve = vi.fn(resolverFor(client));
        const options = {
          resourceUrl: `${origin}/mcp`,
          clerkClient: resolve,
          publicAccess: { methods: ['initialize'] },
        };
        const handler =
          name === 'next'
            ? nextAdapter.withClerkMcpAuth(
                async () => Response.json({ reached: true }),
                options as nextAdapter.McpAuthOptions,
              )
            : name === 'express'
              ? expressAdapter.mcpAuth(options as expressAdapter.McpAuthOptions)
              : name === 'hono'
                ? honoAdapter.mcpAuth(options as honoAdapter.McpAuthOptions)
                : fetchAuth(name, options, () => Response.json({ reached: true }));

        for (const init of [
          { method: 'POST' },
          { body: rpc('initialize') },
          { authorization: 'Bearer t' },
        ]) {
          const error = await reportedError(name, handler, '/mcp', init);
          expect(error).toMatch(
            /^Error: Clerk error: .* takes a clerkClient with authenticateRequest, or a function that returns one\. Omit clerkClient to use /,
          );
          expect(error).toContain(`Omit clerkClient to use ${defaultClientName[name]}`);
        }
        expect(resolve).toHaveBeenCalledTimes(3);
        expect(defaultClient.authenticateRequest).not.toHaveBeenCalled();
      },
    );
  });

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
  const publicAccess = { tools: ['search_docs'] } as const;
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

// `discoverable`: whether a client without a token can connect and list, which is the default
describe.each(authApps)('%s discoverable', (name, mount) => {
  const caller = authCaller[name];
  const send = (options: object, init: Init) => post(mount, { verifyToken, ...options }, init);
  // What the default opens: the handshake of either protocol revision, `ping`, and every list
  const discoveryMessages = [
    rpc('initialize'),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    rpc('server/discover'),
    rpc('ping'),
    rpc('tools/list'),
    rpc('resources/list'),
    rpc('resources/templates/list'),
    rpc('prompts/list'),
  ];

  test.each([
    ['left out', {}],
    ['true', { discoverable: true }],
    ['undefined', { discoverable: undefined }],
  ])(
    'lets the handshake and every list through without a token when discoverable is %s',
    async (_case, options) => {
      for (const body of discoveryMessages) {
        const res = await send(options, { body });
        expect(res.status, JSON.stringify(body)).toBe(200);
        expect(res.body).toEqual({ reached: true, auth: null, body });
      }
      const get = await send(options, { method: 'GET' });
      expect(get.status).toBe(405);
      expect(get.challenge).toBeNull();

      const call = await send(options, { body: rpc('tools/call', { name: 'search_docs' }) });
      expect(call.status).toBe(401);
      expect(call.challenge).toMatch(/^Bearer resource_metadata="/);
    },
  );

  // They are not checked against the caller, so on a stateful server they could reach another user's session
  test.each([
    ['by default', {}],
    [
      'with every method and call open',
      {
        publicAccess: {
          methods: ['initialize', 'ping'],
          tools: ['search_docs'],
          resources: true,
          prompts: true,
        },
      },
    ],
  ])(
    'challenges the cancelled, progress, and roots notifications without a token %s',
    async (_case, options) => {
      for (const body of [
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: 'a', progress: 1 },
        },
        { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
      ]) {
        const res = await send(options, { body });
        expect(res.status, JSON.stringify(body)).toBe(401);
        expect(res.challenge).toMatch(/^Bearer resource_metadata="/);
      }
    },
  );

  test('opens the calls publicAccess names alongside the default', async () => {
    const options = { publicAccess: { tools: ['search_docs'] } };

    expect((await send(options, { body: rpc('initialize') })).status).toBe(200);
    const call = await send(options, { body: rpc('tools/call', { name: 'search_docs' }) });
    expect(call.status).toBe(200);
    expect(call.body).toMatchObject({ reached: true, auth: null });
  });

  test('challenges every request without a token with discoverable: false', async () => {
    for (const body of discoveryMessages) {
      const res = await send({ discoverable: false }, { body });
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(res.challenge).toMatch(/^Bearer resource_metadata="/);
    }
    expect((await send({ discoverable: false }, { method: 'GET' })).status).toBe(401);
  });

  test('verifies a token as usual with discoverable: false', async () => {
    const res = await send(
      { discoverable: false },
      { body: rpc('tools/list'), authorization: 'Bearer token-1' },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reached: true, auth: { token: 'token-1' } });
  });

  test('opens only the methods a publicAccess.methods list names, in place of the default', async () => {
    const options = { publicAccess: { methods: ['initialize'] } };

    expect((await send(options, { body: rpc('initialize') })).status).toBe(200);
    expect((await send(options, { body: rpc('tools/list') })).status).toBe(401);
  });

  test.each([true, false])(
    'rejects discoverable: %s next to publicAccess.methods at setup',
    (discoverable) => {
      expect(() =>
        mount({ verifyToken, discoverable, publicAccess: { methods: ['initialize'] } }),
      ).toThrow(`Clerk error: ${caller} set discoverable or publicAccess.methods, not both`);
    },
  );

  test.each([true, false, 'initialize'])('rejects publicAccess.methods: %j at setup', (methods) => {
    expect(() => mount({ verifyToken, publicAccess: { methods } })).toThrow(
      `Clerk error: ${caller} publicAccess.methods must be a list; use discoverable to open every method`,
    );
  });

  test.each([
    ['tools', { tools: ['search_docs'] }],
    ['resources', { resources: true }],
    ['prompts', { prompts: ['summarize'] }],
  ])(
    'rejects publicAccess.%s with a methods list that opens neither handshake at setup',
    (key, calls) => {
      expect(() =>
        mount({ verifyToken, publicAccess: { methods: ['ping', 'tools/list'], ...calls } }),
      ).toThrow(
        `Clerk error: ${caller} publicAccess.${key} needs publicAccess.methods to include 'initialize' or 'server/discover', so clients can connect without a token`,
      );
    },
  );

  test.each([['initialize'], ['server/discover']])(
    'accepts named calls with a methods list that opens %s',
    (method) => {
      expect(() =>
        mount({ verifyToken, publicAccess: { methods: [method], tools: ['search_docs'] } }),
      ).not.toThrow();
    },
  );

  test.each(['yes', 'false', 1, 0, null])('rejects discoverable %j at setup', (discoverable) => {
    expect(() => mount({ verifyToken, discoverable })).toThrow(
      `Clerk error: ${caller} discoverable must be true or false`,
    );
  });

  test.each([
    ['tools', { tools: ['search_docs'] }],
    ['resources', { resources: true }],
    ['resources', { resources: ['docs://index'] }],
    ['prompts', { prompts: true }],
    ['prompts', { prompts: ['summarize'] }],
  ])('rejects publicAccess.%s with discoverable: false at setup', (key, publicAccess) => {
    expect(() => mount({ verifyToken, discoverable: false, publicAccess })).toThrow(
      `Clerk error: ${caller} publicAccess.${key} needs discoverable, so clients can connect without a token`,
    );
  });

  test('accepts empty placeholders with discoverable: false, which open nothing', async () => {
    const options = {
      discoverable: false,
      publicAccess: { tools: [], resources: false, prompts: false },
    };
    expect(() => mount({ verifyToken, ...options })).not.toThrow();
    expect((await send(options, { body: rpc('initialize') })).status).toBe(401);
  });
});

// Protected resource metadata stays public whatever `discoverable` is, and its handler takes the same option
describe.each(protectedResourceApps)(
  '%s protectedResourceMetadataHandler discoverable',
  (_name, mount) => {
    test.each([true, false])('serves the metadata with discoverable: %s', async (discoverable) => {
      const res = await serve(
        mount({ resourceUrl: `${origin}/mcp`, discoverable }),
        `${WELL_KNOWN}/mcp`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ resource: `${origin}/mcp` });
    });

    test('rejects a discoverable that is not a boolean at setup', () => {
      expect(() => mount({ discoverable: 'yes' })).toThrow(
        'Clerk error: protectedResourceMetadataHandler discoverable must be true or false',
      );
    });

    test('rejects named public calls with discoverable: false at setup', () => {
      expect(() =>
        mount({ discoverable: false, publicAccess: { tools: ['search_docs'] } }),
      ).toThrow(
        'Clerk error: protectedResourceMetadataHandler publicAccess.tools needs discoverable, so clients can connect without a token',
      );
    });
  },
);

// The public identity tool warning is module-level, so each entry point is loaded fresh for its own.
const freshAuthEntryPoints: [AuthEntry, () => Promise<(options: object) => unknown>][] = [
  [
    'express',
    async () => {
      const { mcpAuth } = await import('./express');
      return (options) => mcpAuth(options as expressAdapter.McpAuthOptions);
    },
  ],
  [
    'hono',
    async () => {
      const { mcpAuth } = await import('./hono');
      return (options) => mcpAuth(options as honoAdapter.McpAuthOptions);
    },
  ],
  [
    'next',
    async () => {
      const { withClerkMcpAuth } = await import('./next');
      return (options) =>
        withClerkMcpAuth(async () => new Response(), options as nextAdapter.McpAuthOptions);
    },
  ],
  [
    'fetch',
    async () => {
      const { withClerkMcpAuth } = await import('./fetch');
      return (options) =>
        withClerkMcpAuth(async () => new Response(), options as fetchEntry.McpAuthOptions);
    },
  ],
  [
    'fetch worker',
    async () => {
      const { createClerkMcpWorker } = await import('./fetch');
      return (options) =>
        createClerkMcpWorker({
          ...(options as fetchEntry.McpAuthOptions),
          server: () => ({}) as never,
        });
    },
  ],
];

describe.each(freshAuthEntryPoints)('%s public identity tool warning', (_name, load) => {
  test('warns once at setup when publicAccess.tools lists create_browser_session', async () => {
    vi.resetModules();
    const mount = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mount({ verifyToken, publicAccess: { tools: ['search_docs'] } });
    expect(warn).not.toHaveBeenCalled();
    mount({ verifyToken, publicAccess: { tools: [CREATE_BROWSER_SESSION_TOOL_NAME] } });
    mount({ verifyToken, publicAccess: { tools: [CREATE_BROWSER_SESSION_TOOL_NAME] } });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^Clerk warning: create_browser_session requires a Clerk identity but is listed in publicAccess\.tools\./,
    );
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

// A body the auth check can't read can't be open, so a request without a token gets the 401 challenge that starts
// sign-in, as it did before `discoverable` was on by default, and a one-time warning names the fix.
describe('express without express.json()', () => {
  function appWithoutJsonParser(options: object) {
    const app = express();
    app.post('/mcp', expressAdapter.mcpAuth({ verifyToken, ...options }), (_req, res) => {
      res.json({ reached: true });
    });
    return app;
  }
  const warning =
    'Clerk warning: mcpAuth could not read the JSON body of a request without a token, so discoverable and publicAccess open nothing and the request got the 401 challenge. Mount express.json() before mcpAuth, as app.use(express.json()), or set discoverable: false to require a token for every request';

  test.each([
    ['discoverable by default', {}],
    ['publicAccess', { publicAccess: { methods: ['tools/list'] } }],
  ])(
    'challenges a JSON request without a token when %s, and warns once',
    async (_case, options) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const app = appWithoutJsonParser(options);

      const first = await serve(app, '/mcp', { body: rpc('tools/list') });
      const second = await serve(app, '/mcp', { body: rpc('tools/list') });

      for (const res of [first, second]) {
        expect(res.status).toBe(401);
        expect(res.challenge).toMatch(/^Bearer resource_metadata="/);
      }
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(warning);
      warn.mockRestore();
    },
  );

  test('does not need the parser with discoverable: false, or for a request with a token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notDiscoverable = await serve(appWithoutJsonParser({ discoverable: false }), '/mcp', {
      body: rpc('tools/list'),
    });
    expect(notDiscoverable.status).toBe(401);

    const withToken = await serve(appWithoutJsonParser({}), '/mcp', {
      body: rpc('tools/list'),
      authorization: 'Bearer token-1',
    });
    expect(withToken).toMatchObject({ status: 200, body: { reached: true } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  const padding = 'x'.repeat(2 * 1024 * 1024);
  const challenge =
    /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/;
  const challenged = {
    status: 401,
    challenge: expect.stringMatching(challenge),
    body: { error: 'Unauthorized' },
  };
  const reached = { status: 200, challenge: null, body: { reached: true } };

  // Over 1 MiB the open method is challenged, as the other adapters do
  test.each([
    ['over 1 MiB', 'a Content-Length', { padding }, false, challenged],
    ['over 1 MiB', 'a chunked body', { padding }, true, challenged],
    ['small', 'a Content-Length', undefined, false, reached],
    ['small', 'a chunked body', undefined, true, reached],
  ])(
    'answers an open method whose body is %s, with %s',
    async (_size, _case, params, chunked, answer) => {
      const res = await serve(app(), '/mcp', { body: rpc('initialize', params), chunked });

      expect({ status: res.status, challenge: res.challenge, body: res.body }).toEqual(answer);
    },
  );
});

describe('hono after a middleware read the raw request', () => {
  function appReadingRaw(options: object) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      await c.req.raw.json();
      await next();
    });
    app.post('/mcp', honoAdapter.mcpAuth({ verifyToken, ...options }), (c) =>
      c.json({ reached: true }),
    );
    return app;
  }
  const warning =
    'Clerk warning: mcpAuth could not read the JSON body of a request without a token, because something before it already read c.req.raw, so discoverable and publicAccess open nothing and the request got the 401 challenge. Read the body through Hono, as c.req.json(), or read a copy, as c.req.raw.clone().json(), or set discoverable: false to require a token for every request';

  test.each([
    ['discoverable by default', {}],
    ['publicAccess', { publicAccess: { tools: ['search_docs'] } }],
  ])(
    'challenges a JSON request without a token when %s, and warns once',
    async (_case, options) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const app = appReadingRaw(options);

      const first = await serve(app.fetch, '/mcp', { body: rpc('tools/list') });
      const second = await serve(app.fetch, '/mcp', { body: rpc('tools/list') });

      for (const res of [first, second]) {
        expect(res.status).toBe(401);
        expect(res.challenge).toMatch(/^Bearer resource_metadata="/);
      }
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(warning);
      warn.mockRestore();
    },
  );

  test('lets a request with a token through', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await serve(appReadingRaw({}).fetch, '/mcp', {
      body: rpc('tools/list'),
      authorization: 'Bearer token-1',
    });

    expect(res).toMatchObject({ status: 200, body: { reached: true } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('next after the request body was read', () => {
  function handlerAfterRead(options: object) {
    const handler = nextAdapter.withClerkMcpAuth(async () => Response.json({ reached: true }), {
      verifyToken,
      ...options,
    });
    return async (req: Request) => {
      await req.json();
      return handler(req);
    };
  }

  test('challenges a JSON request without a token, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = handlerAfterRead({});

    const first = await serve(app, '/mcp', { body: rpc('tools/list') });
    const second = await serve(app, '/mcp', { body: rpc('tools/list') });

    for (const res of [first, second]) {
      expect(res.status).toBe(401);
      expect(res.challenge).toMatch(/^Bearer resource_metadata="/);
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/^Clerk warning: .*request\.clone\(\)\.json\(\)/);
    warn.mockRestore();
  });

  test('lets a request with a token through', async () => {
    const res = await serve(handlerAfterRead({}), '/mcp', {
      body: rpc('tools/list'),
      authorization: 'Bearer token-1',
    });

    expect(res).toMatchObject({ status: 200, body: { reached: true } });
  });
});

const CARD_PATH = '/mcp/server-card';
const CARD_TYPE = 'application/mcp-server-card+json';
const CATALOG_PATH = '/.well-known/ai-catalog.json';
// ARD v0.91 section 5.1: `ard.json` is the canonical path, and consumers may also consult its predecessor's
// `ai-catalog.json` as an equivalent entry source. https://agenticresourcediscovery.org/spec/#51-discovery-mechanisms
const ARD_PATH = '/.well-known/ard.json';
const CATALOG_TYPE = 'application/ai-catalog+json';
const card = {
  name: 'com.example/weather',
  version: '1.2.0',
  description: 'Forecasts and current conditions.',
};
// One card on this host and one on another, which the catalog links to without fetching it
const catalogEntries = [
  {
    identifier: 'urn:air:example.com:weather:mcp',
    displayName: 'Weather',
    url: 'https://public.example.com/mcp/server-card',
  },
  {
    identifier: 'urn:air:saas.example:search:mcp',
    displayName: 'Search',
    url: 'https://cards.saas.example/search/server-card',
  },
];

type DiscoveryHandler = 'serverCardHandler' | 'aiCatalogHandler';

// Each adapter's discovery handler on its paths, one handler mounted for every method so OPTIONS and others reach it.
// The Next.js route is the handler each path's route file exports for every method.
const discoveryAdapters: [
  Adapter,
  (handler: DiscoveryHandler, path: string | string[], options: Options) => App,
][] = [
  [
    'express',
    (handler, path, options) => {
      const app = express();
      app.all(
        path,
        expressHandler(options, (o) => expressAdapter[handler](o as never)),
      );
      return app;
    },
  ],
  [
    'hono',
    (handler, path, options) => {
      const app = new Hono();
      const discovery = honoAdapter[handler](at(options, origin) as never);
      for (const each of [path].flat()) app.all(each, discovery);
      return app.fetch;
    },
  ],
  [
    'next',
    (handler, _path, options) => {
      const route = nextAdapter[handler](at(options, origin) as never);
      return (req: Request) => route(req);
    },
  ],
];

const serverCardApps = discoveryAdapters.map(
  ([name, mount]) =>
    [name, (options: Options) => mount('serverCardHandler', CARD_PATH, options)] as const,
);
const aiCatalogApps = discoveryAdapters.map(
  ([name, mount]) =>
    [
      name,
      (options: Options) => mount('aiCatalogHandler', [ARD_PATH, CATALOG_PATH], options),
    ] as const,
);

// The contract both discovery documents share, with the options that make one and what it should serve
const discoveryApps = discoveryAdapters.flatMap(([name, mount]) => [
  [
    `${name} serverCardHandler`,
    (options: Options) => mount('serverCardHandler', CARD_PATH, options),
    {
      handler: 'serverCardHandler',
      path: CARD_PATH,
      type: CARD_TYPE,
      options: { ...card, resourceUrl: 'https://public.example.com/mcp' },
      served: card,
    },
  ] as const,
  [
    `${name} aiCatalogHandler`,
    (options: Options) => mount('aiCatalogHandler', CATALOG_PATH, options),
    {
      handler: 'aiCatalogHandler',
      path: CATALOG_PATH,
      type: CATALOG_TYPE,
      options: { entries: catalogEntries },
      served: { specVersion: '0.9' },
    },
  ] as const,
]);

// The discovery CORS headers: any origin may read the document and send If-Match or If-None-Match with the ETag
const discoveryCors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Content-Type, If-Match, If-None-Match',
  'access-control-expose-headers': 'ETag',
  // The pinned discovery CORS block sets no preflight lifetime
  'access-control-max-age': null,
};

const expectHeaders = (headers: Headers, expected: Record<string, string | null>) => {
  for (const [name, value] of Object.entries(expected)) expect(headers.get(name), name).toBe(value);
};

/** Sends a request with extra headers, which `Init` has no field for. */
async function serveWith(app: App, path: string, method: string, headers: Record<string, string>) {
  if (!('listen' in app)) {
    return read(await app(new Request(`${origin}${path}`, { method, headers })), origin);
  }
  return withListening(app, async (local) =>
    read(
      await fetch(`${local}${path}`, { method, headers, signal: AbortSignal.timeout(5000) }),
      local,
    ),
  );
}

describe.each(discoveryApps)('%s', (_name, mount, doc) => {
  test('answers HEAD with the GET headers and no body', async () => {
    const app = mount(doc.options);
    const get = await serve(app, doc.path);
    const head = await serve(app, doc.path, { method: 'HEAD' });

    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    // RFC 9110 sections 8.6 and 9.3.2: HEAD sends the Content-Length the GET would, as the length is known before
    // the content is sent
    expect(head.headers.get('content-length')).toBe(
      String(Buffer.byteLength(JSON.stringify(get.body))),
    );
    expectHeaders(head.headers, {
      'content-type': doc.type,
      etag: get.headers.get('etag'),
      'cache-control': 'public, max-age=3600',
      ...discoveryCors,
    });
  });

  test('answers the CORS preflight without caching or a body', async () => {
    const res = await serve(mount(doc.options), doc.path, { method: 'OPTIONS' });

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.allow).toBe('GET, HEAD, OPTIONS');
    expectHeaders(res.headers, { ...discoveryCors, 'cache-control': null, etag: null });
  });

  test.each(['POST', 'PUT', 'DELETE', 'PATCH'])(
    'answers %s with a JSON 405 and Allow, never stored',
    async (method) => {
      const res = await serve(mount(doc.options), doc.path, { method });

      expect(res.status).toBe(405);
      expect(res.allow).toBe('GET, HEAD, OPTIONS');
      expect(res.body).toEqual({ error: 'method_not_allowed' });
      expectHeaders(res.headers, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        etag: null,
      });
    },
  );

  test('serves a request carrying a token without Clerk keys, a verifier, or any fetch', async () => {
    vi.unstubAllEnvs();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = mount(doc.options);

    const res = await serve(app, doc.path, { authorization: 'Bearer some-token' });

    expect(res.status).toBe(200);
    expect(defaultClient.authenticateRequest).not.toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.filter(([input]) => !String(input).startsWith('http://127.0.0.1')),
    ).toEqual([]);
  });
});

describe.each(discoveryApps)('%s conditional requests and caching', (_name, mount, doc) => {
  async function tagOf(app: App) {
    const etag = (await serve(app, doc.path)).headers.get('etag')!;
    return { etag, opaque: etag.replace(/^W\//, '') };
  }

  // RFC 9110 section 13.1.2 compares with the weak function of section 8.8.3.2, over a list of entity-tags
  test.each([
    ['the ETag itself', ({ etag }: { etag: string }) => etag],
    ['its opaque-tag without W/', ({ opaque }: { opaque: string }) => opaque],
    ['a list holding it', ({ etag }: { etag: string }) => `"other", ${etag}`],
    ['a list with empty elements', ({ etag }: { etag: string }) => ` , ,${etag},`],
    ['a list after a tag with a comma in it', ({ etag }: { etag: string }) => `"a,b",${etag}`],
    ['*', () => '*'],
  ])(
    'answers GET and HEAD whose If-None-Match is %s with a bodyless 304',
    async (_case, header) => {
      const app = mount(doc.options);
      const tag = await tagOf(app);
      for (const method of ['GET', 'HEAD']) {
        const res = await serveWith(app, doc.path, method, { 'if-none-match': header(tag) });

        expect(res.status, method).toBe(304);
        expect(res.body, method).toBeNull();
        expectHeaders(res.headers, {
          etag: tag.etag,
          'cache-control': 'public, max-age=3600',
          'content-type': null,
          ...discoveryCors,
        });
      }
    },
  );

  test.each([
    ['another tag', () => '"other"'],
    ['the tag with a suffix', ({ opaque }: { opaque: string }) => `W/${opaque.slice(0, -1)}-gzip"`],
    ['the tag unquoted', ({ opaque }: { opaque: string }) => `W/${opaque.slice(1, -1)}`],
    ['the tag inside a longer one', ({ opaque }: { opaque: string }) => `"x${opaque.slice(1)}`],
    ['a list mixing * with the tag', ({ etag }: { etag: string }) => `*, ${etag}`],
  ])('sends the document in full when If-None-Match is %s', async (_case, header) => {
    const app = mount(doc.options);
    const res = await serveWith(app, doc.path, 'GET', {
      'if-none-match': header(await tagOf(app)),
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(doc.served);
  });

  // RFC 9110 section 13.1.1 requires strong comparison: these weak ETags never match a listed tag.
  test.each([
    ['another tag', () => '"other"'],
    ['the weak ETag itself', ({ etag }: { etag: string }) => etag],
    ['its opaque-tag without W/', ({ opaque }: { opaque: string }) => opaque],
    ['a list holding it', ({ etag }: { etag: string }) => `"other", ${etag}`],
    ['an empty field', () => ''],
  ])('rejects GET and HEAD whose If-Match is %s before If-None-Match', async (_case, header) => {
    const app = mount(doc.options);
    const tag = await tagOf(app);
    for (const method of ['GET', 'HEAD']) {
      const res = await serveWith(app, doc.path, method, {
        'if-match': header(tag),
        'if-none-match': '*',
      });

      expect(res.status, method).toBe(412);
      expect(res.body).toEqual(method === 'HEAD' ? null : { error: 'precondition_failed' });
      expectHeaders(res.headers, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
        etag: null,
        ...discoveryCors,
      });
    }
  });

  test.each(['GET', 'HEAD'])(
    'accepts If-Match: * on %s before evaluating If-None-Match',
    async (method) => {
      const app = mount(doc.options);
      const res = await serveWith(app, doc.path, method, { 'if-match': '*' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(method === 'HEAD' ? null : expect.objectContaining(doc.served));

      const unchanged = await serveWith(app, doc.path, method, {
        'if-match': '*',
        'if-none-match': '*',
      });
      expect(unchanged.status).toBe(304);
      expect(unchanged.body).toBeNull();
    },
  );

  test.each(['OPTIONS', 'POST'])('does not evaluate If-Match on %s', async (method) => {
    const res = await serveWith(mount(doc.options), doc.path, method, { 'if-match': '"other"' });
    expect(res.status).toBe(method === 'OPTIONS' ? 200 : 405);
  });

  test('caches for a custom maxAge', async () => {
    const res = await serve(mount({ ...doc.options, maxAge: 60 }), doc.path);

    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  // RFC 9111 section 5.2.2.4: caches may store it, but must revalidate it before each reuse
  test('with maxAge 0, has caches revalidate before each reuse, keeping the ETag', async () => {
    const app = mount({ ...doc.options, maxAge: 0 });
    const res = await serve(app, doc.path);
    const revalidated = await serveWith(app, doc.path, 'GET', {
      'if-none-match': res.headers.get('etag')!,
    });

    expect(res.headers.get('cache-control')).toBe('public, no-cache');
    expect(res.headers.get('etag')).toMatch(/^W\//);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('cache-control')).toBe('public, no-cache');
  });

  test.each([null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '60'])(
    'throws at setup for the maxAge %s',
    (maxAge) => {
      expect(() => mount({ ...doc.options, maxAge })).toThrow(
        `Clerk error: ${doc.handler} maxAge must be a whole number of seconds, 0 or more`,
      );
    },
  );
});

test.each(['GET', 'HEAD'])(
  'Express keeps a missing-host 400 ahead of If-Match on %s',
  async (method) => {
    const app = express();
    app.all(CARD_PATH, expressAdapter.serverCardHandler({ ...card, resourceUrl: unlisted }));
    const raw = await withListening(app, (local) =>
      sendRaw(
        local,
        `${method} ${CARD_PATH} HTTP/1.0\r\nIf-Match: "other"\r\nConnection: close\r\n\r\n`,
      ),
    );
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    expect(raw).toMatch(/Cache-Control: no-store/i);
    const body = raw.split('\r\n\r\n')[1];
    expect(body).toBe(method === 'HEAD' ? '' : '{"error":"invalid_request"}');
  },
);

describe.each(serverCardApps)('%s serverCardHandler', (_name, mount) => {
  const scalar = { ...card, resourceUrl: 'https://public.example.com/mcp' };

  test.each([128, 255])('accepts a version with %i astral code points at setup', async (length) => {
    const version = '🚀'.repeat(length);
    const app = mount({ ...scalar, version });
    const res = await serve(app, CARD_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version });
    expect(
      validateServerCard(JSON.parse(JSON.stringify(res.body))),
      JSON.stringify(validateServerCard.errors),
    ).toBe(true);
  });

  test('rejects a version with 256 astral code points at setup', () => {
    expect(() => mount({ ...scalar, version: '🚀'.repeat(256) })).toThrow(
      'version must be 1 to 255 characters',
    );
  });

  test.each(['packages/server', 'packages/@scope/server', 'packages/server.v2'])(
    'preserves a clean repository-relative subfolder at setup: %s',
    async (subfolder) => {
      const repository = { url: 'https://github.com/example/weather', source: 'github', subfolder };
      const res = await serve(mount({ ...scalar, repository }), CARD_PATH);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ repository });
      expect(validateServerCard(JSON.parse(JSON.stringify(res.body)))).toBe(true);
    },
  );

  test.each([
    '',
    '.',
    '..',
    './packages/server',
    '../outside',
    'packages/./server',
    'packages/../server',
    '/packages/server',
    'packages/server/',
    'packages//server',
    '//other.example/server',
    'https://other.example/server',
    'mailto:server@example.com',
    'C:/packages/server',
    'C:packages/server',
    'packages\\server',
    '\\\\host\\server',
  ])('rejects an unclean repository subfolder at setup: %j', (subfolder) => {
    expect(() =>
      mount({
        ...scalar,
        repository: { url: 'https://github.com/example/weather', source: 'github', subfolder },
      }),
    ).toThrow('serverCardHandler repository');
  });

  test.each([
    'https://user:password@example.com/public',
    'https://user@example.com/public',
    'https://:password@example.com/public',
    'https://us%65r:p%61ss@example.com/public',
  ])('rejects public optional URL credentials at setup: %s', (url) => {
    for (const [field, options] of [
      ['websiteUrl', { websiteUrl: url }],
      ['icons', { icons: [{ src: url }] }],
      ['repository', { repository: { url, source: 'git' } }],
    ] as const) {
      expect(() => mount({ ...scalar, ...options })).toThrow(
        `Clerk error: serverCardHandler ${field}`,
      );
    }
  });

  test('keeps website fragments and encoded paths in the public card', async () => {
    const websiteUrl = 'https://example.com/a%20b#section';
    const app = mount({ ...scalar, websiteUrl });
    const res = await serve(app, CARD_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ websiteUrl });
  });

  test.each(['description', 'title'])('counts %s by Unicode code points at setup', (key) => {
    expect(() => mount({ ...scalar, [key]: '🌤'.repeat(100) })).not.toThrow();
    expect(() => mount({ ...scalar, [key]: '🌤'.repeat(101) })).toThrow(
      `${key} must be 1 to 100 characters`,
    );
  });

  test.each([
    { resourceUrl: 'HTTPS://example.com/mcp' },
    { resourceUrl: 'https:///example.com/mcp' },
    { websiteUrl: 'https:///example.com/public' },
    { icons: [{ src: 'https:///example.com/icon.png' }] },
    { repository: { url: 'https:///example.com/repo', source: 'git' } },
    { resourceUrl: 'https:example.com/mcp' },
    { websiteUrl: 'https://example.com/a b' },
    { icons: [{ src: 'https://example.com/a b' }] },
    { repository: { url: 'https://example.com/a b', source: 'github' } },
    { icons: Object.assign([], { length: 1 }) },
    { icons: [{ src: 'https://example.com/icon.png', sizes: Object.assign([], { length: 1 }) }] },
  ])('rejects schema-invalid options at setup: %j', (options) => {
    expect(() => mount({ ...scalar, ...options })).toThrow('Clerk error: serverCardHandler');
  });

  test('serves the card with its media type, a weak ETag, an hour of public caching, and public CORS', async () => {
    const res = await serve(mount(scalar), CARD_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      ...card,
      remotes: [{ type: 'streamable-http', url: 'https://public.example.com/mcp' }],
    });
    expectHeaders(res.headers, {
      'content-type': CARD_TYPE,
      'cache-control': 'public, max-age=3600',
      ...discoveryCors,
    });
    expect(res.headers.get('etag')).toMatch(/^W\/"[!#-~]+"$/);
  });

  // A scalar is the configured address, whatever origin the request reaches the app at, as behind a proxy
  test('advertises a single resourceUrl whatever origin the request has', async () => {
    const res = await serve(mount(scalar), CARD_PATH);

    expect((res.body as { remotes: unknown }).remotes).toEqual([
      { type: 'streamable-http', url: 'https://public.example.com/mcp' },
    ]);
  });

  test('advertises the listed resourceUrl with the origin of the request, each with its own ETag', async () => {
    const options = (seen: string) => ({
      ...card,
      resourceUrl: ['https://other.example.dev/mcp', `${seen}/mcp`],
    });
    const res = await serve(mount(options), CARD_PATH);
    const other = await serve(
      mount({ ...card, resourceUrl: ['https://other.example.dev/mcp'] }),
      CARD_PATH,
      {},
    );

    expect(res.status).toBe(200);
    expect((res.body as { remotes: unknown }).remotes).toEqual([
      { type: 'streamable-http', url: `${res.origin}/mcp` },
    ]);
    expect(other.status).toBe(421);
    // A scalar, served whatever the origin, as each Express request reaches a listener on another port
    const alone = await serve(mount({ ...card, resourceUrl: `${res.origin}/mcp` }), CARD_PATH);
    const elsewhere = await serve(
      mount({ ...card, resourceUrl: 'https://other.example.dev/mcp' }),
      CARD_PATH,
    );
    expect(alone.headers.get('etag')).toBe(res.headers.get('etag'));
    expect(elsewhere.headers.get('etag')).not.toBe(res.headers.get('etag'));
  });

  // RFC 9110 section 15.5.20. The browser's Origin header plays no part, and no other environment's card is sent.
  test.each([
    ['an unlisted host', unlisted],
    ['another scheme', ['http://mcp.example.com/mcp']],
    ['another port', ['https://mcp.example.com:8443/mcp']],
  ])('answers a request to %s with a JSON 421 that is never stored', async (_case, resourceUrl) => {
    const res = await serveWith(mount({ ...card, resourceUrl }), CARD_PATH, 'GET', {
      origin: 'https://other.example.dev',
      'if-match': '"other"',
      'if-none-match': '*',
    });

    expect(res.status).toBe(421);
    expect(res.body).toEqual({ error: 'misdirected_request' });
    expectHeaders(res.headers, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      etag: null,
    });
  });

  test('answers HEAD to an unlisted origin with a 421 and no body', async () => {
    const res = await serveWith(mount({ ...card, resourceUrl: unlisted }), CARD_PATH, 'HEAD', {
      'if-match': '"other"',
    });

    expect(res.status).toBe(421);
    expect(res.body).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  async function tagOf(app: App) {
    return (await serve(app, CARD_PATH)).headers.get('etag')!;
  }

  test('revalidates against the card for the origin of the request', async () => {
    const res = await serveWith(
      mount((seen: string) => ({
        ...card,
        resourceUrl: ['https://other.example.dev/mcp', `${seen}/mcp`],
      })),
      CARD_PATH,
      'GET',
      {
        'if-none-match': await tagOf(
          mount({ ...card, resourceUrl: 'https://other.example.dev/mcp' }),
        ),
      },
    );

    expect(res.status).toBe(200);
  });
});

test.each(['append', 'replace'])(
  'Express snapshots a resourceUrl list before a caller can %s a matching URL',
  async (mutation) => {
    const app = express();
    await withListening(app, async (local) => {
      const listed = ['https://other.example.dev/mcp'];
      if (mutation === 'replace') listed.push(`${local}/mcp`);
      app.all(CARD_PATH, expressAdapter.serverCardHandler({ ...card, resourceUrl: listed }));

      if (mutation === 'append') listed.push(`${local}/mcp`);
      else listed[1] = 'https://evil.example/mcp';

      const res = await read(
        await fetch(`${local}${CARD_PATH}`, { signal: AbortSignal.timeout(5000) }),
        local,
      );
      expect(res.status).toBe(mutation === 'append' ? 421 : 200);
      if (mutation === 'replace') {
        expect(res.body).toMatchObject({
          remotes: [{ type: 'streamable-http', url: `${local}/mcp` }],
        });
      }
    });
  },
);

describe.each(serverCardApps.filter(([name]) => name !== 'express'))(
  '%s serverCardHandler URL-list snapshot',
  (_name, mount) => {
    test('keeps the listed URLs it was created with when the list changes later', async () => {
      const lacking = ['https://other.example.dev/mcp'];
      const lackingApp = mount({ ...card, resourceUrl: lacking });
      const listed = ['https://other.example.dev/mcp', `${origin}/mcp`];
      const listedApp = mount({ ...card, resourceUrl: listed });

      lacking.push(`${origin}/mcp`);
      listed[1] = 'https://evil.example/mcp';

      expect((await serve(lackingApp, CARD_PATH)).status).toBe(421);
      const res = await serve(listedApp, CARD_PATH);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        remotes: [{ type: 'streamable-http', url: `${origin}/mcp` }],
      });
    });
  },
);

describe.each(serverCardApps)('%s serverCardHandler setup', (_name, mount) => {
  const scalar = { ...card, resourceUrl: 'https://public.example.com/mcp' };

  test('serves the card it was created with when the options change later', async () => {
    const meta = { 'com.example/tier': 'free' };
    const options = { ...scalar, _meta: meta };
    const app = mount(options);
    options.resourceUrl = 'https://evil.example/mcp';
    meta['com.example/tier'] = 'paid';

    const res = await serve(app, CARD_PATH);

    expect(res.body).toMatchObject({
      remotes: [{ type: 'streamable-http', url: 'https://public.example.com/mcp' }],
      _meta: { 'com.example/tier': 'free' },
    });
  });

  test.each([
    ['no options', undefined, 'serverCardHandler takes an options object'],
    [
      'no resourceUrl',
      { ...card },
      'serverCardHandler resourceUrl must be a URL or a non-empty list',
    ],
    [
      'an empty list',
      { ...card, resourceUrl: [] },
      'serverCardHandler resourceUrl must be a URL or a non-empty list',
    ],
    [
      'two URLs for one origin',
      { ...card, resourceUrl: [`${origin}/a`, `${origin}/b`] },
      'serverCardHandler resourceUrl lists more than one URL',
    ],
    [
      'a templated listed URL',
      { ...card, resourceUrl: [`${origin}/{tenant}`] },
      'serverCardHandler resourceUrl must be one absolute http or https URL',
    ],
    ['an invalid card', { ...scalar, name: 'weather' }, 'serverCardHandler name'],
    ['an unknown key', { ...scalar, headers: [] }, 'serverCardHandler does not take headers'],
    ['remotes', { ...scalar, remotes: [] }, 'serverCardHandler cannot set remotes'],
  ])('throws at setup for %s', (_case, options, message) => {
    expect(() => mount(options as never)).toThrow(`Clerk error: ${message}`);
  });
});

describe.each(aiCatalogApps)('%s aiCatalogHandler', (_name, mount) => {
  test.each([
    { entries: Object.assign([], { length: 1 }) },
    { entries: Object.assign([catalogEntries[0]], { length: 2 }) },
  ])('rejects sparse entries at setup: %j', (options) => {
    expect(() => mount(options)).toThrow('Clerk error: aiCatalogHandler entries must be a list');
  });
  const options = { entries: catalogEntries };

  test('serves the catalog with its media type, a weak ETag, an hour of public caching, and public CORS', async () => {
    const res = await serve(mount(options), CATALOG_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      specVersion: '0.9',
      entries: [
        {
          identifier: 'urn:air:example.com:weather:mcp',
          displayName: 'Weather',
          type: CARD_TYPE,
          url: 'https://public.example.com/mcp/server-card',
        },
        {
          identifier: 'urn:air:saas.example:search:mcp',
          displayName: 'Search',
          type: CARD_TYPE,
          url: 'https://cards.saas.example/search/server-card',
        },
      ],
    });
    expect(linkedCardCatalogErrors(res.body)).toEqual([]);
    expectHeaders(res.headers, {
      'content-type': CATALOG_TYPE,
      'cache-control': 'public, max-age=3600',
      ...discoveryCors,
    });
    expect(res.headers.get('etag')).toMatch(/^W\/"[!#-~]+"$/);
  });

  // The same handler on both paths, as each adapter's README mounts it, answers both from the one catalog it built
  test('serves byte-identical catalogs with the same caching headers at ard.json and ai-catalog.json', async () => {
    const app = mount(options);
    const fetchRaw = async (path: string, headers: Record<string, string> = {}) => {
      const res =
        'listen' in app
          ? await withListening(app, (local) =>
              fetch(`${local}${path}`, { headers, signal: AbortSignal.timeout(5000) }),
            )
          : await app(new Request(`${origin}${path}`, { headers }));
      return { status: res.status, headers: res.headers, text: await res.text() };
    };
    const [ard, catalog] = await Promise.all([fetchRaw(ARD_PATH), fetchRaw(CATALOG_PATH)]);

    expect(ard.status).toBe(200);
    expect(catalog.status).toBe(200);
    expect(ard.text).toBe(catalog.text);
    expect(linkedCardCatalogErrors(JSON.parse(ard.text))).toEqual([]);
    for (const name of [
      'content-type',
      'cache-control',
      'etag',
      'vary',
      ...Object.keys(discoveryCors),
    ]) {
      expect(ard.headers.get(name), name).toBe(catalog.headers.get(name));
    }

    // One path's ETag revalidates the other's copy
    const revalidated = await fetchRaw(ARD_PATH, {
      'if-none-match': catalog.headers.get('etag')!,
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe('');
  });

  // ARD v0.91, 4.5 Trust and Verification: the trust manifest is served as given, next to an entry without one
  test('serves an entry trustManifest as given', async () => {
    const trustManifest = {
      identity: 'https://example.com',
      identityType: 'https',
      attestations: [{ type: 'SOC2-Type2', uri: 'https://example.com/compliance/soc2.pdf' }],
    };
    const res = await serve(
      mount({ entries: [{ ...catalogEntries[0]!, trustManifest }, catalogEntries[1]!] }),
      CATALOG_PATH,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      specVersion: '0.9',
      entries: [
        {
          identifier: 'urn:air:example.com:weather:mcp',
          displayName: 'Weather',
          type: CARD_TYPE,
          url: 'https://public.example.com/mcp/server-card',
          trustManifest: {
            identity: 'https://example.com',
            identityType: 'https',
            attestations: [{ type: 'SOC2-Type2', uri: 'https://example.com/compliance/soc2.pdf' }],
          },
        },
        {
          identifier: 'urn:air:saas.example:search:mcp',
          displayName: 'Search',
          type: CARD_TYPE,
          url: 'https://cards.saas.example/search/server-card',
        },
      ],
    });
    expect(linkedCardCatalogErrors(res.body)).toEqual([]);
  });

  test('tags each catalog by its content', async () => {
    const same = await serve(
      mount({ entries: catalogEntries.map((entry) => ({ ...entry })) }),
      CATALOG_PATH,
    );
    const fewer = await serve(mount({ entries: catalogEntries.slice(0, 1) }), CATALOG_PATH);
    const first = await serve(mount(options), CATALOG_PATH);

    expect(same.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(fewer.headers.get('etag')).not.toBe(first.headers.get('etag'));
  });

  // The catalog is fixed: it has no resourceUrl to choose by, so the request's origin and Origin header change nothing
  test('serves the same catalog to a request at another origin or with an Origin header', async () => {
    const app = mount(options);
    const plain = await serve(app, CATALOG_PATH);
    const fromElsewhere = await serveWith(app, CATALOG_PATH, 'GET', {
      origin: 'https://other.example.dev',
    });
    // An Express app is reached at its listener's origin, so only the fetch-style adapters can be sent another one
    const atAnotherOrigin =
      'listen' in app
        ? plain
        : await read(
            await app(new Request(`https://other.example.dev${CATALOG_PATH}`)),
            'https://other.example.dev',
          );

    for (const res of [fromElsewhere, atAnotherOrigin]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
      expect(res.headers.get('etag')).toBe(plain.headers.get('etag'));
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  test('serves the catalog it was created with when the options change later', async () => {
    const entry = { ...catalogEntries[0]! };
    const changing = { entries: [entry] };
    const app = mount(changing);
    entry.url = 'https://evil.example/card';
    changing.entries.push({
      identifier: 'urn:air:evil.example:x:mcp',
      displayName: 'Evil',
      url: 'https://evil.example/x',
    });

    const res = await serve(app, CATALOG_PATH);

    expect(res.body).toEqual({
      specVersion: '0.9',
      entries: [{ ...catalogEntries[0], type: CARD_TYPE }],
    });
  });

  test.each([
    ['no options', undefined, 'aiCatalogHandler takes an options object with entries'],
    [
      'no entries',
      {},
      'aiCatalogHandler entries must be a list of { identifier, displayName, url }',
    ],
    [
      'a specVersion',
      { ...options, specVersion: '0.9' },
      'aiCatalogHandler cannot set specVersion',
    ],
    [
      'a host',
      { ...options, host: { displayName: 'Example' } },
      'aiCatalogHandler does not take host',
    ],
    [
      'a resourceUrl',
      { ...options, resourceUrl: 'https://mcp.example.com/mcp' },
      'aiCatalogHandler does not take resourceUrl',
    ],
    [
      'an inline document',
      { entries: [{ identifier: 'urn:air:example.com:x:mcp', data: {} }] },
      'aiCatalogHandler entries[0] does not take data',
    ],
    [
      'a relative card url',
      {
        entries: [
          { identifier: 'urn:air:example.com:x:mcp', displayName: 'X', url: '/mcp/server-card' },
        ],
      },
      'aiCatalogHandler entries[0].url must be',
    ],
    [
      'an entry without a displayName',
      {
        entries: [
          { identifier: 'urn:air:example.com:x:mcp', url: 'https://example.com/mcp/server-card' },
        ],
      },
      'aiCatalogHandler entries[0].displayName must be',
    ],
    [
      'a trustManifest without an identity',
      { entries: [{ ...catalogEntries[0], trustManifest: { identityType: 'https' } }] },
      'aiCatalogHandler entries[0].trustManifest must be',
    ],
  ])('throws at setup for %s', (_case, invalid, message) => {
    expect(() => mount(invalid as never)).toThrow(`Clerk error: ${message}`);
  });
});
