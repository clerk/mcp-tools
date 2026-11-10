import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler } from 'mcp-handler';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const defaultAuthenticateRequest = vi.hoisted(() => vi.fn());
vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({ authenticateRequest: defaultAuthenticateRequest }),
}));

import {
  McpAuthError,
  type McpAuthFailure,
  McpTokenVerificationError,
  type McpRouteHandler,
  mcpAuth,
  mcpAuthClerk,
  protectedResourceHandler,
  protectedResourceHandlerClerk,
} from './index';

const METADATA_ROOT = 'https://mcp.example.com/.well-known/oauth-protected-resource';
const resourceUrl = 'https://mcp.example.com/mcp';
const RESOURCE_METADATA_URL = `${METADATA_ROOT}/mcp`;
const BARE_CHALLENGE = `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;

describe.each([
  [
    'protectedResourceHandler',
    () => protectedResourceHandler({ authServerUrl: 'https://as.test' }),
  ],
  ['protectedResourceHandlerClerk', () => protectedResourceHandlerClerk()],
])('%s', (name, createHandler) => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  test.each([
    ['/mcp', 'https://mcp.example.com/mcp'],
    ['/mcp/', 'https://mcp.example.com/mcp'],
    ['', 'https://mcp.example.com'],
    ['/', 'https://mcp.example.com'],
  ])('describes the resource for the metadata route suffix %j', async (suffix, resource) => {
    const res = createHandler()(new Request(`${METADATA_ROOT}${suffix}`));

    expect((await res.json()).resource).toBe(resource);
  });

  test('sets resource from properties instead of the route path', async () => {
    const properties = {
      resource: 'https://public.example.com/mcp',
      scopes_supported: ['profile'],
    };
    const handler =
      name === 'protectedResourceHandler'
        ? protectedResourceHandler({ authServerUrl: 'https://as.test', properties })
        : protectedResourceHandlerClerk(properties);

    const metadata = await handler(new Request(`${METADATA_ROOT}/mcp`)).json();

    expect(metadata).toMatchObject(properties);
  });
});

// A route handler that echoes the auth info `mcp-handler` would read from `req.auth`.
const echoAuth: McpRouteHandler = (req) =>
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

describe('mcpAuth', () => {
  test('sends a quoted challenge when the Authorization header is missing', async () => {
    const verifyToken = vi.fn();
    const res = await mcpAuth(verifyToken)(echoAuth)(request());

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(BARE_CHALLENGE);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('derives resource_metadata from resourceUrl instead of the request', async () => {
    const res = await mcpAuth(vi.fn(), { resourceUrl: 'https://public.example.com/mcp' })(echoAuth)(
      request(undefined, 'http://localhost:3000/mcp'),
    );

    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://public.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('derives resource_metadata from the listed resourceUrl with the request origin', async () => {
    const res = await mcpAuth(vi.fn(), {
      resourceUrl: ['https://mcp.example.com/mcp', 'https://other.example.com/mcp'],
    })(echoAuth)(request(undefined, 'https://other.example.com/mcp'));

    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://other.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('answers a request to an unlisted origin with a 421 and does not verify it', async () => {
    const verifyToken = vi.fn();
    const res = await mcpAuth(verifyToken, {
      resourceUrl: ['https://mcp.example.com/mcp', 'https://other.example.com/mcp'],
    })(echoAuth)(request('Bearer token-1', 'https://evil.example.com/mcp'));

    expect(res.status).toBe(421);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
    expect(await res.json()).toEqual({ error: 'misdirected_request' });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('adds invalid_token to the challenge when the token is rejected', async () => {
    const res = await mcpAuth(async () => undefined)(echoAuth)(request('Bearer token-1'));

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`${BARE_CHALLENGE}, error="invalid_token"`);
  });

  test('returns 403 with the granted and missing scopes when requiredScopes are missing', async () => {
    const res = await mcpAuth(async () => authInfo(['profile']), {
      requiredScopes: ['profile', 'email'],
    })(echoAuth)(request('Bearer token-1'));

    expect(res.status).toBe(403);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `${BARE_CHALLENGE}, error="insufficient_scope", scope="profile email"`,
    );
  });

  test('passes the token and request to verifyToken', async () => {
    const verifyToken = vi.fn(async () => authInfo([]));
    const req = request('bearer token-1');

    await mcpAuth(verifyToken)(echoAuth)(req);

    expect(verifyToken).toHaveBeenCalledWith('token-1', req);
  });

  test('sets req.auth with resourceMetadataUrl and calls the handler', async () => {
    const res = await mcpAuth(async () => authInfo(['profile']), {
      requiredScopes: ['profile'],
    })(echoAuth)(request('Bearer token-1'));

    expect(res.status).toBe(200);
    expect((await res.json()).auth).toEqual({
      ...authInfo(['profile']),
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });
  });

  test('throws at setup for an invalid resourceUrl or scope', () => {
    expect(() => mcpAuth(vi.fn(), { resourceUrl: 'not a url' })).toThrow('Clerk error:');
    expect(() => mcpAuth(vi.fn(), { resourceUrl: [] })).toThrow('Clerk error:');
    expect(() => mcpAuth(vi.fn(), { requiredScopes: ['two words'] })).toThrow('Clerk error:');
    expect(() => mcpAuth(vi.fn(), { challengeScopes: ['two words'] })).toThrow('Clerk error:');
  });

  test('lists requiredScopes then challengeScopes in the 401 challenge', async () => {
    const res = await mcpAuth(vi.fn(), {
      requiredScopes: ['profile'],
      challengeScopes: ['email'],
    })(echoAuth)(request());

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`${BARE_CHALLENGE}, scope="profile email"`);
  });

  test('throws an McpAuthError with the verifier error as its cause', async () => {
    const cause = new Error('network down');

    const error = await mcpAuth(() => Promise.reject(cause))(echoAuth)(
      request('Bearer token-1'),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpAuthError);
    expect(error).toMatchObject({ reason: 'verification_failed', cause });
  });
});

describe('mcpAuthClerk', () => {
  const authenticated = (scopes: string[]) => ({
    isAuthenticated: true,
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: 'oauth_token',
      clientId: 'client-1',
      scopes,
      userId: 'user-1',
    }),
  });

  beforeEach(() => {
    defaultAuthenticateRequest.mockReset();
  });

  test('throws a Clerk error without a resourceUrl', () => {
    expect(() => mcpAuthClerk({} as never)).toThrow(
      'Clerk error: mcpAuthClerk needs a resourceUrl',
    );
  });

  test('asks Clerk to check the audience and sets req.auth', async () => {
    defaultAuthenticateRequest.mockResolvedValue(authenticated(['profile']));

    const res = await mcpAuthClerk({ resourceUrl, requiredScopes: ['profile'] })(echoAuth)(
      request('Bearer token-1'),
    );

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

    const res = await mcpAuthClerk({
      resourceUrl,
      onAuthFailure: (failure) => failures.push(failure),
    })(echoAuth)(request('Bearer token-1'));

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`${BARE_CHALLENGE}, error="invalid_token"`);
    expect(await res.text()).not.toContain('audience');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('invalid_token');
    expect(failures[0]?.cause).toBeInstanceOf(McpTokenVerificationError);
    expect(failures[0]?.cause).toMatchObject({ code: 'token-verification-failed' });
  });

  test('passes each failure and its request to onAuthFailure, and nothing for a verified token', async () => {
    const calls: [McpAuthFailure, Request][] = [];
    const wrapped = mcpAuth(async (token) => (token === 'good' ? authInfo([]) : undefined), {
      resourceUrl: [resourceUrl],
      onAuthFailure: (failure, req) => calls.push([failure, req]),
    })(echoAuth);
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

  test('throws when Clerk could not verify the token, instead of answering with a challenge', async () => {
    defaultAuthenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      reason: 'unexpected-error',
      message: 'Clerk is unavailable',
    });

    const error = await mcpAuthClerk({ resourceUrl })(echoAuth)(request('Bearer token-1')).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(McpAuthError);
    const { cause } = error as McpAuthError;
    expect(cause).toBeInstanceOf(McpTokenVerificationError);
    expect(cause).toMatchObject({ code: 'unexpected-error', message: 'Clerk is unavailable' });
  });

  test('verifies with the clerkClient option instead of the default client', async () => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated([]));

    const res = await mcpAuthClerk({ resourceUrl, clerkClient: { authenticateRequest } as never })(
      echoAuth,
    )(request('Bearer token-1'));

    expect(res.status).toBe(200);
    expect(authenticateRequest).toHaveBeenCalledOnce();
    expect(defaultAuthenticateRequest).not.toHaveBeenCalled();
  });

  test('passes the verified auth info to tools in an mcp-handler route', async () => {
    defaultAuthenticateRequest.mockResolvedValue(authenticated(['profile']));
    const handler = createMcpHandler((server) => {
      server.registerTool('whoami', { description: 'Returns the caller' }, async (ctx) => ({
        content: [{ type: 'text', text: JSON.stringify(ctx.http?.authInfo ?? null) }],
      }));
    });

    const res = await mcpAuthClerk({ resourceUrl })(handler)(
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

    const res = await mcpAuthClerk({ resourceUrl, requiredScopes: ['profile', 'email'] })(echoAuth)(
      request('Bearer token-1'),
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `${BARE_CHALLENGE}, error="insufficient_scope", scope="profile email"`,
    );
  });
});
