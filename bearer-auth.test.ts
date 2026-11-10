import { describe, expect, test, vi } from 'vitest';

import {
  McpAuthError,
  McpTokenVerificationError,
  assertMcpAuthOptions,
  authenticateBearer,
  resourceMetadataUrlFor,
  verifyClerkOAuthToken,
} from './bearer-auth';

const authInfo = { token: 't', clientId: 'client-1', scopes: ['profile'] };

function authenticate(
  overrides: Partial<Parameters<typeof authenticateBearer>[0]> = {},
): ReturnType<typeof authenticateBearer> {
  return authenticateBearer({
    authorization: 'Bearer t',
    requestUrl: 'https://mcp.example.com/mcp',
    resourceUrl: undefined,
    requiredScopes: undefined,
    challengeScopes: undefined,
    verifyToken: async () => authInfo,
    ...overrides,
  });
}

describe('resourceUrl validation', () => {
  test.each(['https://mcp.example.com/mcp#tools', 'https://mcp.example.com/mcp#'])(
    'rejects %s, because a resource identifier has no fragment',
    (resourceUrl) => {
      expect(() => assertMcpAuthOptions('mcpAuth', { resourceUrl })).toThrow(
        'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL without credentials or a fragment',
      );
    },
  );

  test.each([
    'https://mcp.example.com',
    'https://mcp.example.com/mcp?tenant=a',
    'http://localhost:3000/mcp',
  ])('accepts %s', (resourceUrl) => {
    expect(() => assertMcpAuthOptions('mcpAuth', { resourceUrl })).not.toThrow();
  });
});

describe('resourceMetadataUrlFor', () => {
  test.each([
    [
      'https://mcp.example.com/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    ],
    ['https://mcp.example.com', 'https://mcp.example.com/.well-known/oauth-protected-resource'],
    ['https://mcp.example.com/', 'https://mcp.example.com/.well-known/oauth-protected-resource'],
    [
      'https://mcp.example.com/mcp?tenant=a',
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp?tenant=a',
    ],
  ])('puts the well-known path between the host and the path and query of %s', (url, expected) => {
    expect(resourceMetadataUrlFor(url)).toBe(expected);
  });
});

describe('authenticateBearer', () => {
  test('derives the metadata URL from the request path, without its query or a trailing slash at the root', async () => {
    const withQuery = await authenticate({
      authorization: undefined,
      requestUrl: 'https://mcp.example.com/mcp?session=1',
    });
    const root = await authenticate({
      authorization: undefined,
      requestUrl: 'https://mcp.example.com/',
    });

    expect(withQuery).toMatchObject({
      challenge:
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    });
    expect(root).toMatchObject({
      challenge:
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    });
  });

  test('answers an unlisted origin with a 421 before reading the token', async () => {
    const verifyToken = vi.fn();

    const result = await authenticate({
      requestUrl: 'https://other.example.com/mcp',
      resourceUrl: ['https://mcp.example.com/mcp'],
      verifyToken,
    });

    expect(result).toEqual({
      ok: false,
      failure: { reason: 'misdirected_request' },
      status: 421,
      challenge: undefined,
      error: 'misdirected_request',
    });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('rejects a token whose verifier throws an McpTokenVerificationError, with it as the cause', async () => {
    const cause = new McpTokenVerificationError('token-revoked', 'The token was revoked');

    const result = await authenticate({
      verifyToken: async () => {
        throw cause;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      failure: { reason: 'invalid_token', cause },
    });
  });

  test('wraps any other verifier error once, and passes an McpAuthError through', async () => {
    const cause = new Error('network down');
    const thrown = new McpAuthError(cause);

    const wrapped = await authenticate({
      verifyToken: async () => {
        throw cause;
      },
    }).catch((error: unknown) => error);
    const passedThrough = await authenticate({
      verifyToken: async () => {
        throw thrown;
      },
    }).catch((error: unknown) => error);

    expect(wrapped).toBeInstanceOf(McpAuthError);
    expect(wrapped).toMatchObject({ cause });
    expect(passedThrough).toBe(thrown);
  });
});

describe('McpAuthError', () => {
  test.each([500, 503, 599])('keeps a %i status from the cause', (status) => {
    expect(new McpAuthError(Object.assign(new Error('unavailable'), { status })).status).toBe(
      status,
    );
  });

  test.each([400, 401, 403, 429, 600, '503'])('drops a %j status from the cause', (status) => {
    expect(
      new McpAuthError(Object.assign(new Error('rejected'), { status })).status,
    ).toBeUndefined();
  });
});

describe('verifyClerkOAuthToken', () => {
  const authenticated = {
    isAuthenticated: true,
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: 'oauth_token',
      clientId: 'client-1',
      scopes: ['profile'],
      userId: 'user-1',
    }),
  };

  test('checks the audience against the URL as written when it is already normalized', async () => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated);

    await verifyClerkOAuthToken({ authenticateRequest }, 't', 'https://mcp.example.com/mcp');

    expect(authenticateRequest.mock.calls[0]?.[1]).toEqual({
      acceptsToken: 'oauth_token',
      audience: 'https://mcp.example.com/mcp',
    });
  });

  test.each([
    ['https://mcp.example.com', 'https://mcp.example.com/'],
    ['https://MCP.Example.com:443/mcp', 'https://mcp.example.com/mcp'],
  ])('also accepts the normalized form of %s as the audience', async (resourceUrl, normalized) => {
    const authenticateRequest = vi.fn().mockResolvedValue(authenticated);

    await verifyClerkOAuthToken({ authenticateRequest }, 't', resourceUrl);

    expect(authenticateRequest.mock.calls[0]?.[1]).toEqual({
      acceptsToken: 'oauth_token',
      audience: [resourceUrl, normalized],
    });
  });

  test('rejects a token Clerk accepted without a user, client, or scopes, with a cause', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const authenticateRequest = vi.fn().mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({ isAuthenticated: true, tokenType: 'oauth_token', clientId: 'client-1' }),
    });

    const error = await verifyClerkOAuthToken(
      { authenticateRequest },
      't',
      'https://mcp.example.com/mcp',
    ).catch((thrown: unknown) => thrown);
    consoleError.mockRestore();

    expect(error).toBeInstanceOf(McpTokenVerificationError);
    expect(error).toMatchObject({ code: 'token-claims-missing' });
  });
});
