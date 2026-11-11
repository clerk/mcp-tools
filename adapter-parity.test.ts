// Rules the Express, Hono, and Next.js adapters must apply the same way, run against all three.
import express from 'express';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@clerk/express', () => ({ clerkClient: { authenticateRequest: vi.fn() } }));

import type { AuthInfo } from './mcp-types';
import { type ProtectedResourceMetadataOptions, resourceMetadataUrlFor } from './bearer-auth';
import * as expressAdapter from './express';
import * as honoAdapter from './hono';
import * as nextAdapter from './next';

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
    const s = app.listen(0, () => resolve(s));
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
