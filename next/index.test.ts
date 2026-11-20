import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler } from 'mcp-handler';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const defaultAuthenticateRequest = vi.fn();
// The shape of `clerkClient` from `@clerk/nextjs/server`: an async function that returns the client
const clerkClient = async () => ({ authenticateRequest: defaultAuthenticateRequest });

// The default client, which `withClerkMcpAuth` loads with `import()` when there is no `clerkClient` option. A test sets
// `clerkNextjsLoad.error` to make that load fail. Every registration of the mock uses this one factory: Vitest
// registers the `vi.doMock` calls queued for one path in parallel, so with different factories a later call would
// not reliably replace an earlier one.
const nextClerkClient = vi.hoisted(() => vi.fn());
const clerkNextjsLoad = vi.hoisted(() => {
  const load = {
    error: undefined as Error | undefined,
    factory: () => {
      if (load.error) throw load.error;
      return { clerkClient: nextClerkClient };
    },
  };
  return load;
});
vi.mock('@clerk/nextjs/server', () => clerkNextjsLoad.factory());

import {
  McpAuthError,
  type McpAuthFailure,
  aiCatalogHandler,
  protectedResourceMetadataHandler,
  serverCardHandler,
  withClerkMcpAuth,
} from './index';
import { clerkAuthenticated, expiresAt, FAKE_PK } from '../test/mcp-harness';
import { linkedCardCatalogErrors } from '../test/ai-catalog-contract';

const METADATA_ROOT = 'https://mcp.example.com/.well-known/oauth-protected-resource';
const resourceUrl = 'https://mcp.example.com/mcp';
const RESOURCE_METADATA_URL = `${METADATA_ROOT}/mcp`;
const BARE_CHALLENGE = `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;

describe('protectedResourceMetadataHandler', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = FAKE_PK;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  test('throws naming the variable when the publishable key is not set', () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

    expect(() => protectedResourceMetadataHandler()(new Request(`${METADATA_ROOT}/mcp`))).toThrow(
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable is required',
    );
  });

  // Next.js calls an exported `GET` with the request and a context, and a request has no own keys to reject as options
  test.each([
    ['a NextRequest', new NextRequest(`${METADATA_ROOT}/mcp`)],
    ['a Request', new Request(`${METADATA_ROOT}/mcp`)],
  ])('throws a Clerk error when exported as GET without being called, given %s', (_name, req) => {
    const exportedUncalled = protectedResourceMetadataHandler as unknown as (
      req: Request,
      ctx: { params: Promise<object> },
    ) => unknown;

    expect(() => exportedUncalled(req, { params: Promise.resolve({}) })).toThrow(
      'Clerk error: call protectedResourceMetadataHandler({ resourceUrl }) and pass its result to the route',
    );
  });

  // Joined so GitHub push protection doesn't read the fake secret key as a Stripe key
  const secretKeyShaped = ['sk', 'test', 'Y2xlcmsuZXhhbXBsZS5jb20k'].join('_');
  test.each(['pk_test_abc', secretKeyShaped, 'pk_test_!!!!'])(
    'throws a Clerk error naming the variable for the publishable key %j',
    (key) => {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = key;

      expect(() => protectedResourceMetadataHandler()(new Request(`${METADATA_ROOT}/mcp`))).toThrow(
        'Clerk error: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not a Clerk publishable key',
      );
    },
  );

  // RFC 9728 section 3.3: the `resource` must be the URL the client derived the metadata URL from
  test('throws at setup when properties sets resource', () => {
    expect(() =>
      protectedResourceMetadataHandler({
        properties: { resource: 'https://public.example.com/mcp' },
      }),
    ).toThrow('Clerk error: protectedResourceMetadataHandler properties cannot set resource');
  });
});

// A route handler that echoes the auth info `mcp-handler` would read from `req.auth`.
const echoAuth = (req: Request): Response =>
  Response.json({ auth: (req as Request & { auth?: AuthInfo }).auth ?? null });

function request(authorization?: string, url = resourceUrl) {
  return new Request(url, {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

const authInfo = (scopes: string[]): AuthInfo => ({
  token: 'token-1',
  clientId: 'client-1',
  scopes,
  expiresAt,
});

describe('withClerkMcpAuth with verifyToken', () => {
  test.each([
    ['without a resourceUrl', {}],
    ['with a resourceUrl', { resourceUrl }],
  ])('passes the token and request to verifyToken %s', async (_name, options) => {
    const verifyToken = vi.fn(async () => authInfo([]));
    const req = request('bearer token-1');

    const res = await withClerkMcpAuth(echoAuth, { ...options, verifyToken })(req);

    expect(res.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith('token-1', req);
  });

  test('throws at setup without a route handler', () => {
    expect(() => withClerkMcpAuth(undefined as never, { verifyToken: vi.fn() })).toThrow(
      'takes the route handler first',
    );
  });

  test('throws at setup for an invalid resourceUrl, naming withClerkMcpAuth', () => {
    expect(() =>
      withClerkMcpAuth(echoAuth, { verifyToken: vi.fn(), resourceUrl: 'not a url' }),
    ).toThrow('Clerk error: withClerkMcpAuth resourceUrl must be an absolute http or https URL');
  });

  test('rejects a non-function verifyToken at setup', () => {
    expect(() => withClerkMcpAuth(echoAuth, { verifyToken: null } as never)).toThrow(
      'Clerk error: withClerkMcpAuth verifyToken must be a function',
    );
  });

  test('answers a verifier that throws with a JSON 500 and logs the McpAuthError with its cause', async () => {
    const cause = new Error('network down');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await withClerkMcpAuth(echoAuth, { verifyToken: () => Promise.reject(cause) })(
      request('Bearer token-1'),
    );
    const [error] = log.mock.calls[0] ?? [];
    log.mockRestore();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    expect(error).toBeInstanceOf(McpAuthError);
    expect(error).toMatchObject({ reason: 'verification_failed', cause });
  });

  test('lets an error the route handler throws reach Next.js', async () => {
    const thrown = new Error('route bug');

    const error = await withClerkMcpAuth(
      () => {
        throw thrown;
      },
      { verifyToken: async () => authInfo([]) },
    )(request('Bearer token-1')).catch((e: unknown) => e);

    expect(error).toBe(thrown);
  });

  test('passes each failure and its request to onAuthFailure, and nothing for a verified token', async () => {
    const calls: [McpAuthFailure, Request][] = [];
    const wrapped = withClerkMcpAuth(echoAuth, {
      verifyToken: async (token) => (token === 'good' ? authInfo([]) : undefined),
      resourceUrl: [resourceUrl],
      onAuthFailure: (failure, req) => calls.push([failure, req]),
    });
    const missing = request();
    const misdirected = new Request('https://other.example.com/mcp', { method: 'POST' });

    await wrapped(missing);
    await wrapped(misdirected);
    await wrapped(request('Bearer good'));

    expect(calls).toEqual([
      [{ reason: 'missing_token' }, missing],
      [{ reason: 'misdirected_request' }, misdirected],
    ]);
  });

  test('does not wait for a promise returned by onAuthFailure', async () => {
    let resolveNotification: (() => void) | undefined;
    const notification = new Promise<void>((resolve) => {
      resolveNotification = resolve;
    });
    const onAuthFailure = vi.fn(() => notification);

    try {
      const res = await withClerkMcpAuth(echoAuth, {
        verifyToken: async () => undefined,
        resourceUrl,
        onAuthFailure,
      })(request());

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
      expect(onAuthFailure).toHaveBeenCalledOnce();
    } finally {
      resolveNotification?.();
    }
  }, 1000);

  test.each([
    [
      'throws',
      () => {
        throw new Error('logger is down');
      },
    ],
    [
      'rejects',
      async () => {
        throw new Error('logger is down');
      },
    ],
  ])(
    'still sends the challenge, without an unhandled rejection, when onAuthFailure %s',
    async (_case, onAuthFailure) => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const res = await withClerkMcpAuth(echoAuth, {
          verifyToken: async () => undefined,
          resourceUrl,
          onAuthFailure,
        })(request());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    },
  );
});

describe('withClerkMcpAuth with Clerk', () => {
  beforeEach(() => {
    defaultAuthenticateRequest.mockReset();
    // The keys `clerkClient` from `@clerk/nextjs/server` reads, which the default client needs
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_123');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', FAKE_PK);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A setup mistake is thrown as it is, not as the cause of an `McpAuthError`, and before any token arrives, as in
  // Express and Hono. Thrown by `@clerk/backend` once a token arrives, it would be a 500 after the client authorized.
  test.each([
    ['CLERK_SECRET_KEY', 'with a token', 'Bearer token-1'],
    ['CLERK_SECRET_KEY', 'without a token', undefined],
    ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'with a token', 'Bearer token-1'],
    ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'without a token', undefined],
  ])(
    'throws a Clerk error naming %s when it is not set, %s',
    async (name, _case, authorization) => {
      vi.stubEnv(name, '');
      const authenticateRequest = vi.fn().mockResolvedValue(clerkAuthenticated([]));
      nextClerkClient.mockResolvedValue({ authenticateRequest });

      const error = await withClerkMcpAuth(echoAuth, { resourceUrl })(request(authorization)).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).not.toBeInstanceOf(McpAuthError);
      expect((error as Error).message).toBe(
        `Clerk error: withClerkMcpAuth needs the ${name} environment variable or a clerkClient option`,
      );
      expect(authenticateRequest).not.toHaveBeenCalled();
    },
  );

  // Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only where it is written out, so a publishable key set
  // only for `next build` is missing from a `process.env[name]` lookup at run time. `vi.stubEnv` sets the run-time
  // value, so only the source shows which form the check uses.
  test('reads each key with a written-out process.env access that Next.js can inline', () => {
    const file = new URL('./index.ts', import.meta.url);
    const source = ts.createSourceFile(
      file.pathname,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
    );
    const isProcessEnv = (node: ts.Node) =>
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      node.name.text === 'env';
    const written: string[] = [];
    const lookedUp: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
        written.push(node.name.text);
      }
      if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
        lookedUp.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(lookedUp).toEqual([]);
    expect(written).toEqual(
      expect.arrayContaining(['CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY']),
    );
  });

  test('does not check the environment for a clerkClient option', async () => {
    vi.stubEnv('CLERK_SECRET_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    defaultAuthenticateRequest.mockResolvedValue(clerkAuthenticated([]));

    const res = await withClerkMcpAuth(echoAuth, { resourceUrl, clerkClient })(
      request('Bearer token-1'),
    );

    expect(res.status).toBe(200);
  });

  test('throws a Clerk error without a resourceUrl, naming the verifyToken alternative', () => {
    const noResourceUrl = () => withClerkMcpAuth(echoAuth, {} as never);
    expect(noResourceUrl).toThrow(
      'Clerk error: withClerkMcpAuth from @clerk/mcp-tools/next needs a resourceUrl',
    );
    expect(noResourceUrl).toThrow('withClerkMcpAuth(handler, { verifyToken })');
  });

  test("throws a Clerk error for mcp-handler's call form, with a verifier function", () => {
    const callForm = () => withClerkMcpAuth(echoAuth, (async () => undefined) as never);
    expect(callForm).toThrow('withClerkMcpAuth(handler, { resourceUrl })');
    expect(callForm).toThrow('withClerkMcpAuth(handler, { verifyToken })');
  });

  test.each([
    ['with a token', 'Bearer token-1'],
    ['without a token', undefined],
  ])('resolves the Clerk client once per request %s', async (_case, authorization) => {
    const authenticateRequest = vi.fn().mockResolvedValue(clerkAuthenticated());
    nextClerkClient.mockReset();
    nextClerkClient.mockResolvedValue({ authenticateRequest });

    const res = await withClerkMcpAuth(echoAuth, { resourceUrl })(request(authorization));

    expect(res.status).toBe(authorization ? 200 : 401);
    expect(nextClerkClient).toHaveBeenCalledOnce();
    expect(authenticateRequest).toHaveBeenCalledTimes(authorization ? 1 : 0);
  });

  // A setup mistake is thrown as it is, not as the cause of an `McpAuthError`, and before any token arrives
  test.each([
    ['with a token', 'Bearer token-1'],
    ['without a token', undefined],
  ])(
    'throws a Clerk error asking to install @clerk/nextjs %s when it cannot be loaded',
    async (_case, authorization) => {
      const loadError = new Error('Cannot find package @clerk/nextjs');
      clerkNextjsLoad.error = loadError;
      // `vi.resetModules()` keeps loaded mocks, so registering the mock again is what drops the loaded one. The next
      // `import()` of `@clerk/nextjs/server` then runs the factory, which throws.
      vi.doMock('@clerk/nextjs/server', clerkNextjsLoad.factory);
      vi.resetModules();
      try {
        const { withClerkMcpAuth: freshWithMcpAuth, McpAuthError: FreshMcpAuthError } =
          await import('./index');

        const error = await freshWithMcpAuth(echoAuth, { resourceUrl })(
          request(authorization),
        ).catch((err: unknown) => err);

        expect(error).not.toBeInstanceOf(FreshMcpAuthError);
        expect((error as Error).message).toBe(
          'Clerk error: install @clerk/nextjs, or pass clerkClient to withClerkMcpAuth',
        );
        // Vitest wraps an error thrown by a mock factory in its own, with the original as that error's cause
        const { cause } = error as Error;
        expect(cause).toBeInstanceOf(Error);
        expect((cause as Error).cause).toBe(loadError);
      } finally {
        // Back to the mock the other tests use, which later imports of `@clerk/nextjs/server` load again
        clerkNextjsLoad.error = undefined;
        vi.doMock('@clerk/nextjs/server', clerkNextjsLoad.factory);
        vi.resetModules();
      }
    },
  );

  test('passes the verified auth info to tools in an mcp-handler route', async () => {
    defaultAuthenticateRequest.mockResolvedValue(clerkAuthenticated(['profile']));
    const handler = createMcpHandler((server) => {
      server.registerTool('whoami', { description: 'Returns the caller' }, async (ctx) => ({
        content: [{ type: 'text', text: JSON.stringify(ctx.http?.authInfo ?? null) }],
      }));
    });

    const res = await withClerkMcpAuth(handler, { clerkClient, resourceUrl })(
      new Request(resourceUrl, {
        method: 'POST',
        headers: {
          authorization: 'Bearer token-1',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    const message = JSON.parse(body.startsWith('{') ? body : body.match(/^data: (.*)$/m)![1]!);
    expect(JSON.parse(message.result.content[0].text)).toMatchObject({
      clientId: 'client-1',
      extra: { userId: 'user-1', verifiedBy: 'clerk' },
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });
  });
});

describe('discovery route handlers', () => {
  // The pinned Card schema, as server-card.test.ts validates it, at the ServerCard definition
  const schema = JSON.parse(
    readFileSync(join(import.meta.dirname, '../test/fixtures/server-card.schema.json'), 'utf8'),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  ajv.addSchema(schema, 'schema.json');
  const validateServerCard = ajv.getSchema('schema.json#/$defs/ServerCard')!;

  const card = { name: 'com.example/weather', version: '1.2.0', description: 'Forecasts.' };
  const CARD_URL = 'https://mcp.example.com/mcp/server-card';
  const CATALOG_URL = 'https://mcp.example.com/.well-known/ai-catalog.json';
  // Next.js calls an exported method with the request and a context holding the route params
  const context = { params: Promise.resolve({}) };

  test('serve a Server Card the pinned schema accepts, and an AI Catalog of linked cards, to a NextRequest', async () => {
    const GET = serverCardHandler({ ...card, resourceUrl: 'https://mcp.example.com/mcp' });
    const catalogGET = aiCatalogHandler({
      entries: [
        { identifier: 'urn:air:example.com:weather:mcp', displayName: 'Weather', url: CARD_URL },
      ],
    });

    const res = await (GET as (req: Request, ctx: unknown) => Response)(
      new NextRequest(CARD_URL),
      context,
    );
    const catalog = await (catalogGET as (req: Request, ctx: unknown) => Response)(
      new NextRequest(CATALOG_URL),
      context,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateServerCard(body), JSON.stringify(validateServerCard.errors)).toBe(true);
    expect(body.remotes).toEqual([{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }]);
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('content-type')).toBe('application/ai-catalog+json');
    expect(linkedCardCatalogErrors(await catalog.json())).toEqual([]);
  });

  // The control for the schema check above: a card the schema rejects fails it
  test('the schema check rejects a card without remotes urls', () => {
    expect(
      validateServerCard({
        $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
        ...card,
        remotes: [{ type: 'streamable-http' }],
      }),
    ).toBe(false);
  });

  // Only the request's own URL selects a listed URL, as for protectedResourceMetadataHandler
  test('select a listed resourceUrl by the request URL, not by Host or X-Forwarded-* headers', async () => {
    const GET = serverCardHandler({
      ...card,
      resourceUrl: ['https://mcp.example.com/mcp', 'https://mcp.example.dev/mcp'],
    });
    const headers = {
      host: 'mcp.example.dev',
      'x-forwarded-host': 'mcp.example.dev',
      'x-forwarded-proto': 'https',
    };

    const res = GET(new Request(CARD_URL, { headers }));
    const unlisted = GET(new Request('https://evil.example/mcp/server-card', { headers }));

    expect((await res.json()).remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    ]);
    expect(unlisted.status).toBe(421);
    expect(await unlisted.json()).toEqual({ error: 'misdirected_request' });
  });

  test.each([
    ['serverCardHandler', serverCardHandler],
    ['aiCatalogHandler', aiCatalogHandler],
  ] as const)('%s exported uncalled throws a Clerk error on the first request', (name, factory) => {
    expect(() => (factory as unknown as (req: Request) => unknown)(new Request(CARD_URL))).toThrow(
      `Clerk error: call ${name}(options) and export its result from the route, instead of exporting ${name} itself`,
    );
  });
});
