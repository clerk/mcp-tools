// Rules the Express, Hono, and Next.js adapters must apply the same way, run against all three.
import express from 'express';
import { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@clerk/express', () => ({ clerkClient: { authenticateRequest: vi.fn() } }));

import type { AuthInfo } from './mcp-types';
import { resourceMetadataUrlFor } from './bearer-auth';
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

  test('express and hono have no metadataCorsHandler', () => {
    expect('metadataCorsHandler' in expressAdapter).toBe(false);
    expect('metadataCorsHandler' in honoAdapter).toBe(false);
  });
});

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

// Each adapter has one auth entry point that takes either verifier: `mcpAuth` in Express and Hono, and `withMcpAuth`
// in Next.js, where a route handler is wrapped instead of preceded by middleware
test('each adapter has a single auth entry point', () => {
  const entryPoints = (adapter: object) =>
    ['mcpAuth', 'mcpAuthClerk', 'withMcpAuth'].filter((name) => name in adapter);

  expect(entryPoints(expressAdapter)).toEqual(['mcpAuth']);
  expect(entryPoints(honoAdapter)).toEqual(['mcpAuth']);
  expect(entryPoints(nextAdapter)).toEqual(['withMcpAuth']);
});

describe.each(mcpRoutes)('%s auth entry point with verifyToken', (_name, send) => {
  test('answers a token whose expiresAt has passed with invalid_token (RFC 6750 section 3.1)', async () => {
    const res = await send('/mcp', { method: 'POST', authorization: 'Bearer t' });

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp", error="invalid_token"`,
    );
  });
});

// Clerk verification, through the same entry points without `verifyToken`
const rejectingClerk = {
  authenticateRequest: vi.fn(async () => ({
    isAuthenticated: false,
    reason: 'token-invalid',
    message: 'Invalid token',
  })),
} as never;

const clerkRoutes: [string, Send][] = [
  [
    'express',
    (path, init) => {
      const app = express();
      // The test server's port is only known once it listens, so the middleware is built per request
      app.post(
        '/mcp',
        (req, res, next) =>
          expressAdapter.mcpAuth({
            resourceUrl: `http://${req.get('host')}/mcp`,
            clerkClient: rejectingClerk,
          })(req, res, next),
        (_req, res) => {
          res.json({ ok: true });
        },
      );
      return sendExpress(app, path, init);
    },
  ],
  [
    'hono',
    async (path, init) => {
      const app = new Hono();
      app.post(
        '/mcp',
        honoAdapter.mcpAuth({ resourceUrl: `${origin}/mcp`, clerkClient: rejectingClerk }),
        (c) => c.json({ ok: true }),
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
        resourceUrl: `${origin}/mcp`,
        clerkClient: rejectingClerk,
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

describe.each(clerkRoutes)('%s Clerk verification', (_name, send) => {
  test('asks Clerk to check the audience and answers a rejected token with invalid_token', async () => {
    const authenticateRequest = vi.mocked(
      (rejectingClerk as { authenticateRequest: () => unknown }).authenticateRequest,
    );
    authenticateRequest.mockClear();

    const res = await send('/mcp', { method: 'POST', authorization: 'Bearer t' });

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}${WELL_KNOWN}/mcp", error="invalid_token"`,
    );
    expect(authenticateRequest).toHaveBeenCalledOnce();
    expect(authenticateRequest.mock.calls[0]).toEqual([
      expect.any(Request),
      { acceptsToken: 'oauth_token', audience: `${res.origin}/mcp` },
    ]);
  });
});
