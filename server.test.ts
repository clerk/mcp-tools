import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { describe, expect, test, vi } from 'vitest';

import {
  createClerkOAuthTokenVerifier,
  type ClerkOAuthAccessToken,
  type ClerkOAuthAccessTokenClient,
  type ClerkOAuthTokenVerifierSource,
} from './server';

const activeToken: ClerkOAuthAccessToken = {
  clientId: 'client_123',
  subject: 'user_123',
  scopes: ['mcp:read', 'mcp:write'],
  revoked: false,
  expired: false,
  expiration: 1_800_000_000_999,
};

describe('createClerkOAuthTokenVerifier', () => {
  test('maps Clerk OAuth access token data to MCP AuthInfo', async () => {
    const verify = vi.fn().mockResolvedValue(activeToken);
    const verifier = createClerkOAuthTokenVerifier({
      idPOAuthAccessToken: { verify },
    });

    await expect(verifier.verifyAccessToken('access-token')).resolves.toEqual({
      token: 'access-token',
      clientId: 'client_123',
      scopes: ['mcp:read', 'mcp:write'],
      expiresAt: 1_800_000_000,
      extra: { userId: 'user_123' },
    });
    expect(verify).toHaveBeenCalledWith('access-token');
  });

  test('accepts Clerk OAuth access token clients directly', async () => {
    const accessTokenClient: ClerkOAuthAccessTokenClient = {
      verify: vi.fn().mockResolvedValue(activeToken),
    };
    const verifier = createClerkOAuthTokenVerifier(accessTokenClient);

    await expect(verifier.verifyAccessToken('access-token')).resolves.toMatchObject({
      clientId: 'client_123',
    });
  });

  test('accepts a lazy Clerk client proxy', async () => {
    const verify = vi.fn().mockResolvedValue(activeToken);
    const clerkClient = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'idPOAuthAccessToken') return { verify };
          return undefined;
        },
      },
    );
    const verifier = createClerkOAuthTokenVerifier(clerkClient as ClerkOAuthTokenVerifierSource);

    await expect(verifier.verifyAccessToken('access-token')).resolves.toMatchObject({
      clientId: 'client_123',
    });
    expect(verify).toHaveBeenCalledWith('access-token');
  });

  test.each([
    ['revoked', { revoked: true }],
    ['expired', { expired: true }],
    ['missing expiration', { expiration: null }],
  ])('rejects a %s Clerk token as invalid', async (_state, overrides) => {
    const verifier = createClerkOAuthTokenVerifier({
      verify: vi.fn().mockResolvedValue({ ...activeToken, ...overrides }),
    });

    const error = await verifier.verifyAccessToken('access-token').catch((cause) => cause);

    expect(OAuthError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ code: OAuthErrorCode.InvalidToken });
  });

  test('maps a Clerk token-not-found response to invalid_token', async () => {
    const clerkError = Object.assign(new Error('Not found'), {
      clerkError: true as const,
      status: 404,
      errors: [],
    });
    const verifier = createClerkOAuthTokenVerifier({
      verify: vi.fn().mockRejectedValue(clerkError),
    });

    const error = await verifier.verifyAccessToken('access-token').catch((cause) => cause);

    expect(OAuthError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ code: OAuthErrorCode.InvalidToken });
  });

  test.each([
    [
      'a transient Clerk response',
      Object.assign(new Error('Service unavailable'), {
        clerkError: true as const,
        status: 503,
        errors: [],
      }),
    ],
    ['an unrelated 404', Object.assign(new Error('Not found'), { status: 404 })],
    ['an unexpected failure', new Error('Network failed')],
  ])('preserves %s as a server failure', async (_case, sourceError) => {
    const verifier = createClerkOAuthTokenVerifier({
      verify: vi.fn().mockRejectedValue(sourceError),
    });

    await expect(verifier.verifyAccessToken('access-token')).rejects.toBe(sourceError);
  });
});
