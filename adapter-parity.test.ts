// Rules the Express, Hono, and Next.js adapters must apply the same way, run against all three.
import express from 'express';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { AddressInfo } from 'node:net';
import { type Server, request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@clerk/express', () => ({ clerkClient: { authenticateRequest: vi.fn() } }));

import type { AuthInfo } from './mcp-types';
import { type ProtectedResourceMetadataOptions, resourceMetadataUrlFor } from './bearer-auth';
import * as expressAdapter from './express';
import * as honoAdapter from './hono';
import * as nextAdapter from './next';
import { requireAdditionalScopes } from './server';

const WELL_KNOWN = '/.well-known/oauth-protected-resource';
const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';

type Answer = { status: number; challenge: string | null; headers: Headers; body: unknown };

/** Sends one request to `path` on a fresh app, and the origin the app saw. */
type Send = (
  path: string,
  init?: { method?: string; authorization?: string },
) => Promise<Answer & { origin: string }>;

async function sendExpress(app: express.Express, path: string, init: Parameters<Send>[1] = {}) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${origin}${path}`, {
      method: init.method ?? 'GET',
      headers: init.authorization ? { authorization: init.authorization } : {},
      signal: AbortSignal.timeout(2000),
    });
    return {
      origin,
      status: res.status,
      challenge: res.headers.get('WWW-Authenticate'),
      headers: res.headers,
      body: await res.json(),
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function answer(res: Response, origin: string) {
  return {
    origin,
    status: res.status,
    challenge: res.headers.get('WWW-Authenticate'),
    headers: res.headers,
    body: await res.json(),
  };
}

const origin = 'https://mcp.example.com';

const metadataRoutes: [string, Send][] = [
  [
    'express',
    (path) => {
      const app = express();
      app.use(WELL_KNOWN, expressAdapter.protectedResourceMetadataHandler());
      return sendExpress(app, path);
    },
  ],
  [
    'hono',
    async (path) => {
      const app = new Hono();
      app.get('*', honoAdapter.protectedResourceMetadataHandler());
      return answer(await app.request(`${origin}${path}`), origin);
    },
  ],
  [
    'next',
    async (path) =>
      answer(
        nextAdapter.protectedResourceMetadataHandler()(new Request(`${origin}${path}`)),
        origin,
      ),
  ],
];

describe.each(metadataRoutes)('%s protectedResourceMetadataHandler', (_name, send) => {
  beforeEach(() => {
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  // RFC 9728 section 3.3: the `resource` must be identical to the URL the metadata URL was derived from, so each
  // suffix maps back to the resource whose `resourceMetadataUrlFor` it is
  test.each([
    ['', ''],
    ['/mcp', '/mcp'],
    ['/mcp/', '/mcp/'],
    ['/mcp?tenant=1', '/mcp?tenant=1'],
    ['?tenant=1', '?tenant=1'],
  ])('describes the resource for the suffix %j', async (suffix, resourcePath) => {
    const res = await send(`${WELL_KNOWN}${suffix}`);

    expect(res.status).toBe(200);
    const resource = (res.body as { resource: string }).resource;
    expect(resource).toBe(`${res.origin}${resourcePath}`);
    expect(resourceMetadataUrlFor(resource)).toBe(`${res.origin}${WELL_KNOWN}${suffix}`);
  });
});

// The options every adapter's handler takes, without an adapter's verification-only keys
type MetadataOptions = ProtectedResourceMetadataOptions;

/** Sends a metadata request to a handler whose options are made from the origin the app sees. */
type SendWithOptions = (optionsFor: (origin: string) => MetadataOptions) => ReturnType<Send>;

const metadataRoutesWithOptions: [string, SendWithOptions][] = [
  [
    'express',
    (optionsFor) => {
      const app = express();
      // The port is not known until the app listens, so the handler is made from the request's own origin
      app.use(WELL_KNOWN, (req, res) =>
        expressAdapter.protectedResourceMetadataHandler(optionsFor(`http://${req.host}`))(req, res),
      );
      return sendExpress(app, `${WELL_KNOWN}/mcp`);
    },
  ],
  [
    'hono',
    async (optionsFor) => {
      const app = new Hono();
      app.get('*', honoAdapter.protectedResourceMetadataHandler(optionsFor(origin)));
      return answer(await app.request(`${origin}${WELL_KNOWN}/mcp`), origin);
    },
  ],
  [
    'next',
    async (optionsFor) =>
      answer(
        nextAdapter.protectedResourceMetadataHandler(optionsFor(origin))(
          new Request(`${origin}${WELL_KNOWN}/mcp`),
        ),
        origin,
      ),
  ],
];

describe.each(metadataRoutesWithOptions)(
  '%s protectedResourceMetadataHandler with resourceUrl',
  (_name, send) => {
    beforeEach(() => {
      process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = FAKE_PK;
    });

    afterEach(() => {
      delete process.env.CLERK_PUBLISHABLE_KEY;
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    });

    // Behind a proxy the app sees another origin than the public one, and RFC 9728 section 3.3 has the client discard
    // metadata whose `resource` is not the URL it derived the metadata URL from
    test('describes a single resourceUrl whatever origin the request has', async () => {
      const res = await send(() => ({ resourceUrl: 'https://public.example.com/mcp' }));

      expect(res.status).toBe(200);
      expect((res.body as { resource: string }).resource).toBe('https://public.example.com/mcp');
    });

    test('describes the listed resourceUrl with the origin of the request', async () => {
      const res = await send((requestOrigin) => ({
        resourceUrl: ['https://other.example.dev/mcp', `${requestOrigin}/mcp`],
      }));

      expect(res.status).toBe(200);
      expect((res.body as { resource: string }).resource).toBe(`${res.origin}/mcp`);
    });

    // RFC 9110 section 15.5.20: the target URI matches no origin the server is configured for
    test('answers a request to an origin no resourceUrl lists with a 421', async () => {
      const res = await send(() => ({
        resourceUrl: ['https://other.example.dev/mcp', 'https://another.example.dev/mcp'],
      }));

      expect(res.status).toBe(421);
      expect(res.body).toEqual({ error: 'misdirected_request' });
    });
  },
);

/** Serves a metadata request from a handler given `options`, a shared object typed by the adapter's own options. */
const metadataRoutesWithAuthOptions: [string, (options: object) => ReturnType<Send>][] = [
  [
    'express',
    (options) => {
      const app = express();
      app.use(
        WELL_KNOWN,
        expressAdapter.protectedResourceMetadataHandler(
          options as expressAdapter.ProtectedResourceMetadataOptions,
        ),
      );
      return sendExpress(app, `${WELL_KNOWN}/mcp`);
    },
  ],
  [
    'hono',
    async (options) => {
      const app = new Hono();
      app.get(
        '*',
        honoAdapter.protectedResourceMetadataHandler(
          options as honoAdapter.ProtectedResourceMetadataOptions,
        ),
      );
      return answer(await app.request(`${origin}${WELL_KNOWN}/mcp`), origin);
    },
  ],
  [
    'next',
    async (options) =>
      answer(
        nextAdapter.protectedResourceMetadataHandler(
          options as nextAdapter.ProtectedResourceMetadataOptions,
        )(new Request(`${origin}${WELL_KNOWN}/mcp`)),
        origin,
      ),
  ],
];

describe.each(metadataRoutesWithAuthOptions)(
  '%s protectedResourceMetadataHandler given the mcpAuth options',
  (_name, send) => {
    beforeEach(() => {
      process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = FAKE_PK;
    });

    afterEach(() => {
      delete process.env.CLERK_PUBLISHABLE_KEY;
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    });

    test.each([
      ['clerkClient', { clerkClient: { authenticateRequest: vi.fn() } }],
      ['verifyToken', { verifyToken: vi.fn() }],
    ])('ignores %s', async (_key, verifier) => {
      const res = await send({
        resourceUrl: 'https://public.example.com/mcp',
        requiredScopes: ['profile'],
        ...verifier,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        resource: 'https://public.example.com/mcp',
        scopes_supported: ['profile'],
      });
      for (const fn of Object.values(verifier)) {
        expect(fn instanceof Function ? fn : fn.authenticateRequest).not.toHaveBeenCalled();
      }
    });
  },
);

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

const AUTH_SERVER_PATH = '/.well-known/oauth-authorization-server';
const clerkMetadata = { issuer: 'https://clerk.example.com' };

// Each adapter's metadata handlers answer with the headers they always have: Next.js adds caching and CORS, since a
// route file has no middleware, and Express and Hono leave CORS to the framework's own middleware.
const metadataHeaderCases: [string, string, Send, Record<string, string | null>][] = [
  [
    'express',
    'protectedResourceMetadataHandler',
    (path) => {
      const app = express();
      app.use(WELL_KNOWN, expressAdapter.protectedResourceMetadataHandler());
      return sendExpress(app, path);
    },
    { 'access-control-allow-origin': null, 'cache-control': null },
  ],
  [
    'express',
    'authorizationServerMetadataHandler',
    (path) => {
      const app = express();
      app.get(AUTH_SERVER_PATH, expressAdapter.authorizationServerMetadataHandler());
      return sendExpress(app, path);
    },
    { 'access-control-allow-origin': null, 'cache-control': null },
  ],
  [
    'hono',
    'protectedResourceMetadataHandler',
    async (path) => {
      const app = new Hono();
      app.get('*', honoAdapter.protectedResourceMetadataHandler());
      return answer(await app.request(`${origin}${path}`), origin);
    },
    { 'access-control-allow-origin': null, 'cache-control': null },
  ],
  [
    'hono',
    'authorizationServerMetadataHandler',
    async (path) => {
      const app = new Hono();
      app.get('*', honoAdapter.authorizationServerMetadataHandler());
      return answer(await app.request(`${origin}${path}`), origin);
    },
    { 'access-control-allow-origin': null, 'cache-control': null },
  ],
  [
    'next',
    'protectedResourceMetadataHandler',
    async (path) =>
      answer(
        nextAdapter.protectedResourceMetadataHandler()(new Request(`${origin}${path}`)),
        origin,
      ),
    {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
      'cache-control': 'max-age=3600',
      'content-type': 'application/json',
    },
  ],
  [
    'next',
    'authorizationServerMetadataHandler',
    async () => answer(await nextAdapter.authorizationServerMetadataHandler()(), origin),
    {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
      'cache-control': 'max-age=3600',
      'content-type': 'application/json',
    },
  ],
];

describe('metadata handler headers', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = FAKE_PK;
    // Answer Clerk's metadata fetch, and let the Express requests through to the local server
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      String(input).startsWith('https://clerk.example.com/')
        ? Promise.resolve(Response.json(clerkMetadata))
        : realFetch(input, init),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  test.each(metadataHeaderCases)('%s %s', async (_adapter, handler, send, expected) => {
    const path =
      handler === 'protectedResourceMetadataHandler' ? `${WELL_KNOWN}/mcp` : AUTH_SERVER_PATH;
    const res = await send(path);

    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(expected)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    if (handler === 'authorizationServerMetadataHandler') expect(res.body).toEqual(clerkMetadata);
  });

  test.each(
    metadataHeaderCases.filter(([, handler]) => handler === 'authorizationServerMetadataHandler'),
  )(
    '%s %s answers a JSON 502 when Clerk metadata cannot be fetched',
    async (adapter, _handler, send) => {
      vi.mocked(globalThis.fetch).mockImplementation((input, init) =>
        String(input).startsWith('https://clerk.example.com/')
          ? Promise.resolve(new Response('nope', { status: 400 }))
          : realFetch(input, init),
      );
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await send(AUTH_SERVER_PATH);

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'server_error' });
      // A failure must not be cached like the metadata is
      expect(res.headers.get('cache-control')).toBeNull();
      if (adapter === 'next') expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(String(log.mock.calls[0]?.[0])).toContain('failed with status 400');
    },
  );

  // RFC 9110 section 15.6.3: a 502 is for an invalid answer from an upstream server, and here none was asked
  test.each<[string, () => Promise<unknown>]>([
    [
      'express',
      async () => {
        let error: unknown;
        const app = express();
        app.get(AUTH_SERVER_PATH, expressAdapter.authorizationServerMetadataHandler());
        app.use(((err, _req, res, _next) => {
          error = err;
          res.status(500).json({});
        }) satisfies express.ErrorRequestHandler);
        await sendExpress(app, AUTH_SERVER_PATH);
        return error;
      },
    ],
    [
      'hono',
      async () => {
        let error: unknown;
        const app = new Hono();
        app.onError((err, c) => {
          error = err;
          return c.json({}, 500);
        });
        app.get('*', honoAdapter.authorizationServerMetadataHandler());
        await app.request(`${origin}${AUTH_SERVER_PATH}`);
        return error;
      },
    ],
    [
      'next',
      () =>
        nextAdapter
          .authorizationServerMetadataHandler()()
          .catch((error: unknown) => error),
    ],
  ])(
    '%s authorizationServerMetadataHandler throws for a key that is not a publishable key, instead of a 502',
    async (adapter, run) => {
      const name =
        adapter === 'next' ? 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY' : 'CLERK_PUBLISHABLE_KEY';
      process.env[name] = 'pk_test_abc';

      const error = await run();

      expect(String(error)).toContain(`Clerk error: ${name} is not a Clerk publishable key`);
      expect(globalThis.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining('oauth-authorization-server'),
      );
    },
  );

  test('next metadataCorsHandler answers a preflight with the CORS headers', () => {
    const res = nextAdapter.metadataCorsHandler()();

    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    });
  });
});

// 0.9.0's `authServerMetadataHandlerClerk` was passed to the route without being called, so code that only renames it
// passes `authorizationServerMetadataHandler` itself, and the framework calls it with the request. Each case mounts it
// that way and returns the error the app reported.
const uncalledAuthorizationServerRoutes: [string, () => Promise<string>][] = [
  [
    'express',
    async () => {
      const app = express();
      let error: unknown;
      app.get(
        AUTH_SERVER_PATH,
        expressAdapter.authorizationServerMetadataHandler as unknown as express.RequestHandler,
      );
      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          error = err;
          res.status(500).json({ error: 'server_error' });
        },
      );
      const res = await sendExpress(app, AUTH_SERVER_PATH);
      expect(res.status).toBe(500);
      return String(error);
    },
  ],
  [
    'hono',
    async () => {
      const app = new Hono();
      let error: unknown;
      app.onError((err, c) => {
        error = err;
        return c.json({ error: 'server_error' }, 500);
      });
      app.get(
        AUTH_SERVER_PATH,
        honoAdapter.authorizationServerMetadataHandler as unknown as MiddlewareHandler,
      );
      const res = await app.request(`${origin}${AUTH_SERVER_PATH}`);
      expect(res.status).toBe(500);
      return String(error);
    },
  ],
  [
    'next',
    async () => {
      const GET = nextAdapter.authorizationServerMetadataHandler as unknown as (
        req: Request,
      ) => Promise<Response>;
      try {
        await GET(new Request(`${origin}${AUTH_SERVER_PATH}`));
      } catch (error) {
        return String(error);
      }
      return 'no error';
    },
  ],
];

describe.each(uncalledAuthorizationServerRoutes)(
  '%s authorizationServerMetadataHandler passed without being called',
  (_name, sendUncalled) => {
    beforeEach(() => {
      process.env.CLERK_PUBLISHABLE_KEY = FAKE_PK;
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = FAKE_PK;
    });

    afterEach(() => {
      delete process.env.CLERK_PUBLISHABLE_KEY;
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    });

    test('throws a Clerk error naming the fix instead of hanging', async () => {
      expect(await sendUncalled()).toContain(
        'Clerk error: call authorizationServerMetadataHandler() and pass its result',
      );
    });
  },
);

const expired = (): AuthInfo => ({
  token: 't',
  clientId: 'client-1',
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) - 60,
});
const verifyExpired = async () => expired();

const mcpRoutes: [string, Send][] = [
  [
    'express',
    (path, init) => {
      const app = express();
      app.post('/mcp', expressAdapter.mcpAuth({ verifyToken: verifyExpired }), (_req, res) => {
        res.json({ ok: true });
      });
      return sendExpress(app, path, init);
    },
  ],
  [
    'hono',
    async (path, init) => {
      const app = new Hono();
      app.post('/mcp', honoAdapter.mcpAuth({ verifyToken: verifyExpired }), (c) =>
        c.json({ ok: true }),
      );
      return answer(
        await app.request(`${origin}${path}`, {
          method: init?.method,
          headers: init?.authorization ? { authorization: init.authorization } : {},
        }),
        origin,
      );
    },
  ],
  [
    'next',
    async (path, init) => {
      const handler = nextAdapter.withMcpAuth(() => Response.json({ ok: true }), {
        verifyToken: verifyExpired,
      });
      return answer(
        await handler(
          new Request(`${origin}${path}`, {
            method: init?.method,
            headers: init?.authorization ? { authorization: init.authorization } : {},
          }),
        ),
        origin,
      );
    },
  ],
];

describe.each(mcpRoutes)('%s auth entry point with verifyToken', (_name, send) => {
  test('answers a token whose expiresAt has passed with invalid_token (RFC 6750 section 3.1)', async () => {
    const res = await send('/mcp', { method: 'POST', authorization: 'Bearer t' });

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp", error="invalid_token"`,
    );
  });
});

// The Clerk branch of each adapter, given a client whose `authenticateRequest` answers with `state`
type SendClerk = (state: unknown) => ReturnType<Send>;

const clerkResourceUrl = `${origin}/mcp`;
const clerkClientAnswering = (state: unknown) => ({
  authenticateRequest: vi.fn().mockResolvedValue(state),
});

const clerkRoutes: [string, SendClerk][] = [
  [
    'express',
    (state) => {
      const app = express();
      app.post(
        '/mcp',
        expressAdapter.mcpAuth({
          resourceUrl: clerkResourceUrl,
          clerkClient: clerkClientAnswering(state),
        }),
        (_req, res) => {
          res.json({ ok: true });
        },
      );
      return sendExpress(app, '/mcp', { method: 'POST', authorization: 'Bearer t' });
    },
  ],
  [
    'hono',
    async (state) => {
      // No `app.onError`: Hono's default handler answers with the error's `getResponse()`
      const app = new Hono();
      app.post(
        '/mcp',
        honoAdapter.mcpAuth({
          resourceUrl: clerkResourceUrl,
          clerkClient: clerkClientAnswering(state),
        }),
        (c) => c.json({ ok: true }),
      );
      return answer(
        await app.request(`${origin}/mcp`, {
          method: 'POST',
          headers: { authorization: 'Bearer t' },
        }),
        origin,
      );
    },
  ],
  [
    'next',
    async (state) => {
      const handler = nextAdapter.withMcpAuth(() => Response.json({ ok: true }), {
        resourceUrl: clerkResourceUrl,
        clerkClient: clerkClientAnswering(state),
      });
      return answer(
        await handler(
          new Request(`${origin}/mcp`, { method: 'POST', headers: { authorization: 'Bearer t' } }),
        ),
        origin,
      );
    },
  ],
];

// How `@clerk/backend` reports a token it could not verify at all, with the status each adapter answers. Releases
// after 3.27.0 report a JWKS that can't be loaded as `jwk-remote-failed-to-load`; 3.27.0 reports it as
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
];

describe.each(clerkRoutes)(
  '%s auth entry point when Clerk cannot verify the token',
  (_name, send) => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test.each(unverifiable)(
      'answers %s (%s) with a JSON %i and logs the McpAuthError',
      async (reason, message, status) => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = await send({ isAuthenticated: false, reason, message });

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
      const res = await send({
        isAuthenticated: false,
        reason: 'token-verification-failed',
        message: 'JWT signature is invalid. (code=token-verification-failed, status=n/a)',
      });

      expect(res.status).toBe(401);
      expect(res.challenge).toContain('error="invalid_token"');
    });
  },
);

// Two `Authorization` headers carry two credentials, and none of them is the one to verify. Fetch `Headers` join them
// into one value, which the Hono and Next.js adapters see; Node's `http` keeps only the first in `req.headers`.
const verifyFirst = (token: string): AuthInfo | undefined =>
  token === 'first' ? { token, clientId: 'client-1', scopes: [] } : undefined;
const duplicateAuthorization = ['Bearer first', 'Bearer second'];

function fetchHeadersWithDuplicates() {
  const headers = new Headers();
  for (const value of duplicateAuthorization) headers.append('authorization', value);
  return headers;
}

const duplicateAuthorizationRoutes: [
  string,
  () => Promise<{ status: number; challenge: string | null }>,
][] = [
  [
    'express',
    async () => {
      const app = express();
      app.post('/mcp', expressAdapter.mcpAuth({ verifyToken: verifyFirst }), (_req, res) => {
        res.json({ ok: true });
      });
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const { port } = server.address() as AddressInfo;
        // `fetch` would join the headers, so the request is sent with `http`, which sends each value on its own line
        return await new Promise((resolve, reject) => {
          const req = httpRequest(
            { host: '127.0.0.1', port, method: 'POST', path: '/mcp' },
            (res) => {
              res.resume();
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  challenge: (res.headers['www-authenticate'] as string | undefined) ?? null,
                }),
              );
            },
          );
          req.setHeader('authorization', duplicateAuthorization);
          req.on('error', reject);
          req.end();
        });
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  ],
  [
    'hono',
    async () => {
      const app = new Hono();
      app.post('/mcp', honoAdapter.mcpAuth({ verifyToken: verifyFirst }), (c) =>
        c.json({ ok: true }),
      );
      const res = await app.request(`${origin}/mcp`, {
        method: 'POST',
        headers: fetchHeadersWithDuplicates(),
      });
      return { status: res.status, challenge: res.headers.get('WWW-Authenticate') };
    },
  ],
  [
    'next',
    async () => {
      const handler = nextAdapter.withMcpAuth(() => Response.json({ ok: true }), {
        verifyToken: verifyFirst,
      });
      const res = await handler(
        new Request(`${origin}/mcp`, { method: 'POST', headers: fetchHeadersWithDuplicates() }),
      );
      return { status: res.status, challenge: res.headers.get('WWW-Authenticate') };
    },
  ],
];

describe.each(duplicateAuthorizationRoutes)('%s duplicate Authorization headers', (_name, send) => {
  test('challenges the request as malformed instead of verifying one of them', async () => {
    const res = await send();

    expect(res.status).toBe(401);
    expect(res.challenge).toMatch(/^Bearer resource_metadata="[^"]+"$/);
  });
});

// `publicAccess`: what a request without a token may reach, and what it gets when it may not. The same routes carry
// the scope options for the scope challenge.
type PublicAccessOptions = {
  publicAccess?: nextAdapter.PublicAccess | undefined;
  requiredScopes?: readonly string[] | undefined;
  challengeScopes?: readonly string[] | undefined;
};

type PublicAccessInit = {
  method?: string;
  authorization?: string;
  body?: unknown;
  contentType?: string;
};

/** What the route behind the auth saw, when the request reached it. */
type Reached = { reached: true; auth: AuthInfo | null; body: unknown };

type SendPublic = (
  options: PublicAccessOptions,
  init?: PublicAccessInit,
) => Promise<{ status: number; challenge: string | null; allow: string | null; body: unknown }>;

const TOKENS: Record<string, AuthInfo> = {
  'token-1': { token: 'token-1', clientId: 'client-1', scopes: ['profile'] },
};
// A token `scoped:<scopes>` grants the comma-separated scopes, standing in for the grant a reauthorization returns.
const verifyToken = (token: string): AuthInfo | undefined => {
  const scopes = /^scoped:(.*)$/.exec(token)?.[1];
  if (scopes === undefined) return TOKENS[token];
  return { token, clientId: 'client-1', scopes: scopes.split(',').filter(Boolean) };
};

function publicRequestInit({
  method = 'POST',
  authorization,
  body,
  contentType,
}: PublicAccessInit) {
  return {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': contentType ?? 'application/json' }),
      ...(authorization && { authorization }),
    },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  };
}

async function publicAnswer(res: Response) {
  return {
    status: res.status,
    challenge: res.headers.get('WWW-Authenticate'),
    allow: res.headers.get('Allow'),
    body: await res.json(),
  };
}

const publicAccessRoutes: [string, SendPublic][] = [
  [
    'express',
    async (options, init = {}) => {
      const app = express();
      app.use(express.json());
      // An app that also takes form posts on other routes, so a form-encoded body arrives parsed
      app.use(express.urlencoded());
      app.all('/mcp', expressAdapter.mcpAuth({ verifyToken, ...options }), (req, res) => {
        res.json({
          reached: true,
          auth: (req as express.Request & { auth?: AuthInfo }).auth ?? null,
          body: req.body ?? null,
        } satisfies Reached);
      });
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const { port } = server.address() as AddressInfo;
        return await publicAnswer(
          await fetch(`http://127.0.0.1:${port}/mcp`, {
            ...publicRequestInit(init),
            signal: AbortSignal.timeout(2000),
          }),
        );
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  ],
  [
    'hono',
    async (options, init = {}) => {
      const app = new Hono();
      app.all('/mcp', honoAdapter.mcpAuth({ verifyToken, ...options }), async (c) =>
        c.json({
          reached: true,
          auth: c.get('mcpAuth') ?? null,
          // Read after the middleware, as the MCP transport does
          body: await c.req.json().catch(() => null),
        } satisfies Reached),
      );
      return publicAnswer(await app.request(`${origin}/mcp`, publicRequestInit(init)));
    },
  ],
  [
    'next',
    async (options, init = {}) => {
      const handler = nextAdapter.withMcpAuth(
        async (req) =>
          Response.json({
            reached: true,
            auth: (req as Request & { auth?: AuthInfo }).auth ?? null,
            body: await req.json().catch(() => null),
          } satisfies Reached),
        { verifyToken, ...options },
      );
      return publicAnswer(await handler(new Request(`${origin}/mcp`, publicRequestInit(init))));
    },
  ],
];

const rpc = (method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  ...(params && { params }),
});

describe.each(publicAccessRoutes)('%s publicAccess', (_name, send) => {
  const publicAccess = { methods: true, tools: ['search_docs'] } as const;

  test('without it, a request without a token gets the 401', async () => {
    const res = await send({}, { body: rpc('initialize') });

    expect(res.status).toBe(401);
    expect(res.challenge).toMatch(/^Bearer resource_metadata="/);
  });

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

  test('challenges a batch with one protected message', async () => {
    const res = await send(
      { publicAccess },
      { body: [rpc('tools/list'), rpc('tools/call', { name: 'whoami' })] },
    );

    expect(res.status).toBe(401);
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

  test('rejects a token that does not verify, even on an open method', async () => {
    const res = await send(
      { publicAccess },
      { body: rpc('initialize'), authorization: 'Bearer unknown' },
    );

    expect(res.status).toBe(401);
    expect(res.challenge).toContain('error="invalid_token"');
  });

  test('passes the auth info of a token that verifies', async () => {
    const res = await send(
      { publicAccess },
      { body: rpc('tools/call', { name: 'whoami' }), authorization: 'Bearer token-1' },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reached: true, auth: { clientId: 'client-1' } });
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

  test('answers a GET without a token with the 401 when the handshake is closed', async () => {
    const res = await send({ publicAccess: { tools: ['search_docs'] } }, { method: 'GET' });

    expect(res.status).toBe(401);
    expect(res.challenge).toMatch(/^Bearer resource_metadata="/);
  });

  test('lets a GET with a token through', async () => {
    const res = await send({ publicAccess }, { method: 'GET', authorization: 'Bearer token-1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reached: true, auth: { clientId: 'client-1' } });
  });
});

// One 403 names every scope a tool needs when its scopes are in `challengeScopes`, so the client reauthorizes once
// (MCP 2026-07-28 scope challenges). Only `requiredScopes` decides whether the request gets the 403.
describe.each(publicAccessRoutes)('%s insufficient_scope challenge', (_name, send) => {
  const body = rpc('tools/call', { name: 'list_projects' });

  test('lists the granted scopes, then every missing required and challenge scope, once each', async () => {
    const res = await send(
      {
        requiredScopes: ['profile', 'email'],
        challengeScopes: ['email', 'projects:read', 'profile'],
      },
      { body, authorization: 'Bearer token-1' },
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
      { body, authorization: 'Bearer scoped:email' },
    );

    expect(res.status).toBe(403);
    expect(res.challenge).toMatch(
      /, error="insufficient_scope", scope="email profile projects:read"$/,
    );
  });

  // The adapter half of one reauthorization: a token granted the 403's `scope` passes the middleware, and the tool's
  // `requireAdditionalScopes` check on the auth info the route receives asks for nothing more.
  test('lets a token granted the 403 scope through with no further tool challenge', async () => {
    const options = { requiredScopes: ['profile', 'email'], challengeScopes: ['projects:read'] };
    const first = await send(options, { body, authorization: 'Bearer scoped:email' });
    const scope = /scope="([^"]*)"$/.exec(first.challenge ?? '')?.[1];
    expect(first.status).toBe(403);
    expect(scope).toBe('email profile projects:read');

    const second = await send(options, {
      body,
      authorization: `Bearer scoped:${scope?.replaceAll(' ', ',')}`,
    });

    expect(second.status).toBe(200);
    const { auth } = second.body as Reached;
    expect(auth).not.toBeNull();
    expect(requireAdditionalScopes('projects:read')({ authInfo: auth! })).toBeUndefined();
  });

  test('lets a token that lacks only challengeScopes entries through', async () => {
    const res = await send(
      { requiredScopes: ['profile'], challengeScopes: ['projects:read'] },
      { body, authorization: 'Bearer token-1' },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reached: true, auth: { clientId: 'client-1' } });
  });
});

describe('express publicAccess without express.json()', () => {
  async function post(app: express.Express, init: PublicAccessInit) {
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        ...publicRequestInit(init),
        signal: AbortSignal.timeout(2000),
      });
      return { status: res.status, body: await res.json() };
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function appWithoutJsonParser(options: PublicAccessOptions) {
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
    const res = await post(appWithoutJsonParser({ publicAccess: { methods: true } }), {
      body: rpc('initialize'),
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      message:
        'Clerk error: mcpAuth publicAccess reads the parsed JSON body of the request. Mount express.json() before mcpAuth, as app.use(express.json())',
    });
  });

  test('does not need the parser without publicAccess, or for a request with a token', async () => {
    const withoutOption = await post(appWithoutJsonParser({}), { body: rpc('initialize') });
    expect(withoutOption.status).toBe(401);

    const withToken = await post(appWithoutJsonParser({ publicAccess: { methods: true } }), {
      body: rpc('initialize'),
      authorization: 'Bearer token-1',
    });
    expect(withToken).toEqual({ status: 200, body: { reached: true } });
  });
});

describe('express publicAccess behind express.json() with a limit over 1 MiB', () => {
  const publicAccess = { methods: ['initialize'] } as const;

  // `chunked` sends the body as a stream, without a `Content-Length`
  async function post(body: unknown, { chunked = false } = {}) {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.post('/mcp', expressAdapter.mcpAuth({ verifyToken, publicAccess }), (_req, res) => {
      res.json({ reached: true });
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const init = publicRequestInit({ body });
      return await publicAnswer(
        await fetch(`http://127.0.0.1:${port}/mcp`, {
          ...init,
          ...(chunked && {
            body: new Blob([init.body ?? '']).stream(),
            duplex: 'half',
          }),
          signal: AbortSignal.timeout(5000),
        } as RequestInit),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  test.each([
    ['a Content-Length', false],
    ['a chunked body', true],
  ])(
    'challenges an open method whose body is over 1 MiB, with %s, as the other adapters do',
    async (_case, chunked) => {
      const res = await post(rpc('initialize', { padding: 'x'.repeat(2 * 1024 * 1024) }), {
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
    const res = await post(rpc('initialize'), { chunked });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });
});

describe('hono publicAccess behind a middleware that reads the body first', () => {
  const publicAccess = { methods: true, tools: ['search_docs'] } as const;

  async function post(readBody: (c: Context) => Promise<unknown>, init: PublicAccessInit) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      await readBody(c);
      await next();
    });
    app.post('/mcp', honoAdapter.mcpAuth({ verifyToken, publicAccess }), (c) =>
      c.json({ reached: true, auth: c.get('mcpAuth') ?? null }),
    );
    app.onError((error, c) => c.json({ message: error.message }, 500));
    const res = await app.request(`${origin}/mcp`, publicRequestInit(init));
    return { status: res.status, body: await res.json() };
  }

  test.each<[string, (c: Context) => Promise<unknown>]>([
    // What `createMcpHonoApp` from `@modelcontextprotocol/hono` does
    ['a copy of the request', (c) => c.req.raw.clone().json()],
    ['c.req.json()', (c) => c.req.json()],
    ['c.req.text()', (c) => c.req.text()],
  ])('lets an open method through when it read %s', async (_label, readBody) => {
    const res = await post(readBody, { body: rpc('initialize') });

    expect(res).toEqual({ status: 200, body: { reached: true, auth: null } });
  });

  test('still challenges a protected call when it read c.req.json()', async () => {
    const res = await post((c) => c.req.json(), {
      body: rpc('tools/call', { name: 'delete_user' }),
    });

    expect(res.status).toBe(401);
  });

  test('throws a setup error when it read the raw request, which leaves nothing to check', async () => {
    const res = await post((c) => c.req.raw.json(), { body: rpc('initialize') });

    expect(res).toEqual({
      status: 500,
      body: {
        message:
          'Clerk error: publicAccess reads the body of the request, and something before the auth check already read it. Read a copy there instead, as request.clone().json()',
      },
    });
  });
});
