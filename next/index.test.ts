import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const defaultAuthenticateRequest = vi.hoisted(() => vi.fn());
vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({ authenticateRequest: defaultAuthenticateRequest }),
}));

import {
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
])('%s', (_name, createHandler) => {
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
    expect(() => mcpAuth(vi.fn(), { requiredScopes: ['two words'] })).toThrow('Clerk error:');
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
      reason: 'token-invalid-audience',
    });

    const res = await mcpAuthClerk({ resourceUrl })(echoAuth)(request('Bearer token-1'));

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`${BARE_CHALLENGE}, error="invalid_token"`);
  });

  test('throws when Clerk could not verify the token, instead of answering with a challenge', async () => {
    defaultAuthenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      reason: 'unexpected-error',
      message: 'Clerk is unavailable',
    });

    await expect(
      mcpAuthClerk({ resourceUrl })(echoAuth)(request('Bearer token-1')),
    ).rejects.toThrow('Clerk error: MCP access token verification failed');
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
