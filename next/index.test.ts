import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler } from 'mcp-handler';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const defaultAuthenticateRequest = vi.fn();
// The shape of `clerkClient` from `@clerk/nextjs/server`: an async function that returns the client
const clerkClient = async () => ({ authenticateRequest: defaultAuthenticateRequest });

// The default client, which `withMcpAuth` loads with `import()` when there is no `clerkClient` option. A test sets
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
  McpTokenVerificationError,
  protectedResourceMetadataHandler,
  withMcpAuth,
} from './index';

const METADATA_ROOT = 'https://mcp.example.com/.well-known/oauth-protected-resource';
const resourceUrl = 'https://mcp.example.com/mcp';
const RESOURCE_METADATA_URL = `${METADATA_ROOT}/mcp`;
const BARE_CHALLENGE = `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;

describe('protectedResourceMetadataHandler', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  test.each([
    ['/mcp', 'https://mcp.example.com/mcp'],
    ['/mcp/', 'https://mcp.example.com/mcp/'],
    ['', 'https://mcp.example.com'],
  ])('describes the resource for the metadata route suffix %j', async (suffix, resource) => {
    const res = protectedResourceMetadataHandler()(new Request(`${METADATA_ROOT}${suffix}`));

    expect((await res.json()).resource).toBe(resource);
  });

  test('throws naming the variable when the publishable key is not set', () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

    expect(() => protectedResourceMetadataHandler()(new Request(`${METADATA_ROOT}/mcp`))).toThrow(
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable is required',
    );
  });

  test('sets resource from properties instead of the route path', async () => {
    const properties = {
      resource: 'https://public.example.com/mcp',
      scopes_supported: ['profile'],
    };
    const metadata = await protectedResourceMetadataHandler({ properties })(
      new Request(`${METADATA_ROOT}/mcp`),
    ).json();

    expect(metadata).toMatchObject(properties);
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
});

describe('withMcpAuth with verifyToken', () => {
  test('sends a quoted challenge when the Authorization header is missing', async () => {
    const verifyToken = vi.fn();
    const res = await withMcpAuth(echoAuth, { verifyToken })(request());

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('derives resource_metadata from resourceUrl instead of the request', async () => {
    const res = await withMcpAuth(echoAuth, {
      verifyToken: vi.fn(),
      resourceUrl: 'https://public.example.com/mcp',
    })(request(undefined, 'http://localhost:3000/mcp'));

    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://public.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('derives resource_metadata from the listed resourceUrl with the request origin', async () => {
    const res = await withMcpAuth(echoAuth, {
      verifyToken: vi.fn(),
      resourceUrl: ['https://mcp.example.com/mcp', 'https://other.example.com/mcp'],
    })(request(undefined, 'https://other.example.com/mcp'));

    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://other.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('answers a request to an unlisted origin with a 421 and does not verify it', async () => {
    const verifyToken = vi.fn();
    const res = await withMcpAuth(echoAuth, {
      verifyToken,
      resourceUrl: ['https://mcp.example.com/mcp', 'https://other.example.com/mcp'],
    })(request('Bearer token-1', 'https://evil.example.com/mcp'));

    expect(res.status).toBe(421);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    expect(await res.json()).toEqual({ error: 'misdirected_request' });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('adds invalid_token to the challenge when the token is rejected', async () => {
    const res = await withMcpAuth(echoAuth, { verifyToken: async () => undefined })(
      request('Bearer token-1'),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`${BARE_CHALLENGE}, error="invalid_token"`);
  });

  test('returns 403 with the granted and missing scopes when requiredScopes are missing', async () => {
    const res = await withMcpAuth(echoAuth, {
      verifyToken: async () => authInfo(['profile']),
      requiredScopes: ['profile', 'email'],
    })(request('Bearer token-1'));

    expect(res.status).toBe(403);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `${BARE_CHALLENGE}, error="insufficient_scope", scope="profile email"`,
    );
  });

  test.each([
    ['without a resourceUrl', {}],
    ['with a resourceUrl', { resourceUrl }],
  ])('passes the token and request to verifyToken %s', async (_name, options) => {
    const verifyToken = vi.fn(async () => authInfo([]));
    const req = request('bearer token-1');

    const res = await withMcpAuth(echoAuth, { ...options, verifyToken })(req);

    expect(res.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith('token-1', req);
  });

  test('sets req.auth with resourceMetadataUrl and calls the handler', async () => {
    const res = await withMcpAuth(echoAuth, {
      verifyToken: async () => authInfo(['profile']),
      requiredScopes: ['profile'],
    })(request('Bearer token-1'));

    expect(res.status).toBe(200);
    expect((await res.json()).auth).toEqual({
      ...authInfo(['profile']),
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });
  });

  test('throws at setup for an invalid resourceUrl or scope', () => {
    const verifyToken = vi.fn();
    expect(() => withMcpAuth(echoAuth, { verifyToken, resourceUrl: 'not a url' })).toThrow(
      'Clerk error:',
    );
    expect(() => withMcpAuth(echoAuth, { verifyToken, resourceUrl: [] })).toThrow('Clerk error:');
    expect(() => withMcpAuth(echoAuth, { verifyToken, requiredScopes: ['two words'] })).toThrow(
      'Clerk error:',
    );
    expect(() => withMcpAuth(echoAuth, { verifyToken, challengeScopes: ['two words'] })).toThrow(
      'Clerk error:',
    );
  });

  test('throws at setup without a route handler', () => {
    expect(() => withMcpAuth(undefined as never, { verifyToken: vi.fn() })).toThrow(
      'takes the route handler first',
    );
  });

  test('lists requiredScopes then challengeScopes in the 401 challenge', async () => {
    const res = await withMcpAuth(echoAuth, {
      verifyToken: vi.fn(),
      requiredScopes: ['profile'],
      challengeScopes: ['email'],
    })(request());

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`${BARE_CHALLENGE}, scope="profile email"`);
  });

  test('throws an McpAuthError with the verifier error as its cause', async () => {
    const cause = new Error('network down');

    const error = await withMcpAuth(echoAuth, { verifyToken: () => Promise.reject(cause) })(
      request('Bearer token-1'),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpAuthError);
    expect(error).toMatchObject({ reason: 'verification_failed', cause });
  });

  test('passes each failure and its request to onAuthFailure, and nothing for a verified token', async () => {
    const calls: [McpAuthFailure, Request][] = [];
    const wrapped = withMcpAuth(echoAuth, {
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
      const res = await withMcpAuth(echoAuth, {
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

  test('still sends the challenge when onAuthFailure throws', async () => {
    const res = await withMcpAuth(echoAuth, {
      verifyToken: async () => undefined,
      resourceUrl,
      onAuthFailure: () => {
        throw new Error('logger is down');
      },
    })(request());

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
  });

  test('still sends the challenge, without an unhandled rejection, when onAuthFailure rejects', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const res = await withMcpAuth(echoAuth, {
        verifyToken: async () => undefined,
        resourceUrl,
        onAuthFailure: async () => {
          throw new Error('logger is down');
        },
      })(request());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('withMcpAuth with Clerk', () => {
  const authenticated = (scopes: string[]) => ({
    isAuthenticated: true,
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: 'oauth_token',
      id: 'oat_1',
      subject: 'user-1',
      getToken: async () => 'token',
      clientId: 'client-1',
      scopes,
      userId: 'user-1',
    }),
  });

  beforeEach(() => {
    defaultAuthenticateRequest.mockReset();
  });

  test('throws a Clerk error without a resourceUrl, naming the verifyToken alternative', () => {
    const noResourceUrl = () => withMcpAuth(echoAuth, {} as never);
    expect(noResourceUrl).toThrow(
      'Clerk error: withMcpAuth from @clerk/mcp-tools/next needs a resourceUrl',
    );
    expect(noResourceUrl).toThrow('withMcpAuth(handler, { verifyToken })');
  });

  test("throws a Clerk error for mcp-handler's call form, with a verifier function", () => {
    const callForm = () => withMcpAuth(echoAuth, (async () => undefined) as never);
    expect(callForm).toThrow('withMcpAuth(handler, { resourceUrl })');
    expect(callForm).toThrow('withMcpAuth(handler, { verifyToken })');
  });

  test('throws a Clerk error without a route handler', () => {
    expect(() => withMcpAuth({ resourceUrl, clerkClient } as never, undefined as never)).toThrow(
      'takes the route handler first',
    );
  });

  test('throws at setup for an invalid resourceUrl or scope', () => {
    expect(() => withMcpAuth(echoAuth, { clerkClient, resourceUrl: 'not a url' })).toThrow(
      'Clerk error:',
    );
    expect(() =>
      withMcpAuth(echoAuth, { clerkClient, resourceUrl, challengeScopes: ['two words'] }),
    ).toThrow('Clerk error:');
  });

  test('lists requiredScopes then challengeScopes in the 401 challenge', async () => {
    const res = await withMcpAuth(echoAuth, {
      clerkClient,
      resourceUrl,
      requiredScopes: ['profile'],
      challengeScopes: ['browser_session'],
    })(request());

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `${BARE_CHALLENGE}, scope="profile browser_session"`,
    );
    expect(defaultAuthenticateRequest).not.toHaveBeenCalled();
  });

  test('asks Clerk to check the audience and sets req.auth', async () => {
    defaultAuthenticateRequest.mockResolvedValue(authenticated(['profile']));

    const res = await withMcpAuth(echoAuth, {
      clerkClient,
      resourceUrl,
      requiredScopes: ['profile'],
    })(request('Bearer token-1'));

    expect(res.status).toBe(200);
    const [verified, options] = defaultAuthenticateRequest.mock.calls[0]!;
    expect(verified.headers.get('authorization')).toBe('Bearer token-1');
    expect(options).toEqual({ acceptsToken: 'oauth_token', audience: resourceUrl });
    expect((await res.json()).auth).toMatchObject({
      clientId: 'client-1',
      extra: { userId: 'user-1', verifiedBy: 'clerk' },
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });
  });

  test('answers a rejected token with the invalid_token challenge', async () => {
    defaultAuthenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      reason: 'token-verification-failed',
      message: 'OAuth audience mismatch. (code=token-verification-failed, status=n/a)',
    });
    const failures: McpAuthFailure[] = [];

    const res = await withMcpAuth(echoAuth, {
      clerkClient,
      resourceUrl,
      onAuthFailure: (failure) => failures.push(failure),
    })(request('Bearer token-1'));

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`${BARE_CHALLENGE}, error="invalid_token"`);
    expect(await res.text()).not.toContain('audience');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('invalid_token');
    expect(failures[0]?.cause).toBeInstanceOf(McpTokenVerificationError);
    expect(failures[0]?.cause).toMatchObject({ code: 'token-verification-failed' });
  });

  test('passes each failure and its request to onAuthFailure, and nothing for a verified token', async () => {
    defaultAuthenticateRequest.mockResolvedValue(authenticated([]));
    const calls: [McpAuthFailure, Request][] = [];
    const wrapped = withMcpAuth(echoAuth, {
      clerkClient,
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

  test('still sends the challenge when onAuthFailure throws', async () => {
    const res = await withMcpAuth(echoAuth, {
      clerkClient,
      resourceUrl,
      onAuthFailure: () => {
        throw new Error('logger is down');
      },
    })(request());

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
  });

  test('still sends the challenge, without an unhandled rejection, when onAuthFailure rejects', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const res = await withMcpAuth(echoAuth, {
        clerkClient,
        resourceUrl,
        onAuthFailure: async () => {
          throw new Error('logger is down');
        },
      })(request());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('throws when Clerk could not verify the token, instead of answering with a challenge', async () => {
    defaultAuthenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      reason: 'unexpected-error',
      message: 'Clerk is unavailable',
    });

    const error = await withMcpAuth(echoAuth, { clerkClient, resourceUrl })(
      request('Bearer token-1'),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(McpAuthError);
    const { cause } = error as McpAuthError;
    expect(cause).toBeInstanceOf(McpTokenVerificationError);
    expect(cause).toMatchObject({ code: 'unexpected-error', message: 'Clerk is unavailable' });
  });

  test('verifies with a Clerk client object as well as the clerkClient function', async () => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated([]));

    const res = await withMcpAuth(echoAuth, {
      resourceUrl,
      clerkClient: { authenticateRequest } as never,
    })(request('Bearer token-1'));

    expect(res.status).toBe(200);
    expect(authenticateRequest).toHaveBeenCalledOnce();
    expect(defaultAuthenticateRequest).not.toHaveBeenCalled();
  });

  test('verifies with clerkClient from @clerk/nextjs/server without a clerkClient option', async () => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated([]));
    nextClerkClient.mockResolvedValue({ authenticateRequest });

    const res = await withMcpAuth(echoAuth, { resourceUrl })(request('Bearer token-1'));

    expect(res.status).toBe(200);
    expect(nextClerkClient).toHaveBeenCalled();
    expect(authenticateRequest).toHaveBeenCalledOnce();
    expect(defaultAuthenticateRequest).not.toHaveBeenCalled();
  });

  test.each([
    ['with a token', 'Bearer token-1'],
    ['without a token', undefined],
  ])('resolves the Clerk client once per request %s', async (_case, authorization) => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated([]));
    const resolve = vi.fn(async () => ({ authenticateRequest }));
    nextClerkClient.mockReset();
    nextClerkClient.mockResolvedValue({ authenticateRequest });

    for (const options of [{ resourceUrl, clerkClient: resolve }, { resourceUrl }]) {
      await withMcpAuth(echoAuth, options)(request(authorization));
    }

    expect(resolve).toHaveBeenCalledOnce();
    expect(nextClerkClient).toHaveBeenCalledOnce();
    expect(authenticateRequest).toHaveBeenCalledTimes(authorization ? 2 : 0);
  });

  test('keeps the status Clerk reported for an opaque token it could not check', async () => {
    defaultAuthenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      reason: 'unexpected-error',
      message: 'Unexpected error (code=unexpected-error, status=503)',
    });

    const error = await withMcpAuth(echoAuth, { clerkClient, resourceUrl })(
      request('Bearer token-1'),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(McpAuthError);
    expect(error).toMatchObject({ status: 503, cause: { status: 503 } });
  });

  test('prefers the clerkClient option over the one from @clerk/nextjs/server', async () => {
    nextClerkClient.mockClear();
    defaultAuthenticateRequest.mockResolvedValue(authenticated([]));

    const res = await withMcpAuth(echoAuth, { resourceUrl, clerkClient })(
      request('Bearer token-1'),
    );

    expect(res.status).toBe(200);
    expect(nextClerkClient).not.toHaveBeenCalled();
  });

  test('throws at setup for a clerkClient without authenticateRequest', () => {
    expect(() => withMcpAuth(echoAuth, { resourceUrl, clerkClient: {} as never })).toThrow(
      "Omit clerkClient to use clerkClient from '@clerk/nextjs/server'",
    );
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
        const { withMcpAuth: freshWithMcpAuth, McpAuthError: FreshMcpAuthError } =
          await import('./index');

        const error = await freshWithMcpAuth(echoAuth, { resourceUrl })(
          request(authorization),
        ).catch((err: unknown) => err);

        expect(error).not.toBeInstanceOf(FreshMcpAuthError);
        expect((error as Error).message).toBe(
          'Clerk error: install @clerk/nextjs, or pass clerkClient to withMcpAuth',
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
    defaultAuthenticateRequest.mockResolvedValue(authenticated(['profile']));
    const handler = createMcpHandler((server) => {
      server.registerTool('whoami', { description: 'Returns the caller' }, async (ctx) => ({
        content: [{ type: 'text', text: JSON.stringify(ctx.http?.authInfo ?? null) }],
      }));
    });

    const res = await withMcpAuth(handler, { clerkClient, resourceUrl })(
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

  test('answers a token without the required scopes with a 403 challenge', async () => {
    defaultAuthenticateRequest.mockResolvedValue(authenticated(['profile']));

    const res = await withMcpAuth(echoAuth, {
      clerkClient,
      resourceUrl,
      requiredScopes: ['profile', 'email'],
    })(request('Bearer token-1'));

    expect(res.status).toBe(403);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `${BARE_CHALLENGE}, error="insufficient_scope", scope="profile email"`,
    );
  });
});
