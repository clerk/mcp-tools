import type { MachineAuthObject } from '@clerk/backend';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { verifyClerkToken } from './server';

const token = 'oat_test_token';
const resource = 'https://mcp.example.test/mcp';

function authenticated(overrides: Record<string, unknown> = {}) {
  return {
    isAuthenticated: true,
    tokenType: 'oauth_token',
    id: 'oat_123',
    subject: 'user_123',
    userId: 'user_123',
    clientId: 'client_123',
    scopes: ['read:foo'],
    getToken: () => Promise.resolve(token),
    has: () => false,
    debug: () => ({}),
    ...overrides,
  } as unknown as MachineAuthObject<'oauth_token'>;
}

describe('verifyClerkToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns auth info without a resource when none is configured', () => {
    expect(verifyClerkToken(authenticated({ aud: ['https://other.example.test'] }), token)).toEqual(
      {
        token,
        scopes: ['read:foo'],
        clientId: 'client_123',
        extra: { userId: 'user_123' },
      },
    );
  });

  test('returns auth info bound to the resource when aud includes it', () => {
    const authInfo = verifyClerkToken(
      authenticated({ aud: ['https://other.example.test', resource] }),
      token,
      {
        resource,
      },
    );

    expect(authInfo?.resource).toEqual(new URL(resource));
    expect(authInfo?.clientId).toBe('client_123');
    expect(authInfo?.scopes).toEqual(['read:foo']);
  });

  test('rejects a token whose aud does not include the resource', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      verifyClerkToken(authenticated({ aud: ['https://other.example.test'] }), token, { resource }),
    ).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });

  test('rejects a token without an aud when a resource is configured', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(verifyClerkToken(authenticated(), token, { resource })).toBeUndefined();
  });

  test('rejects an unauthenticated auth object', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(verifyClerkToken(authenticated({ isAuthenticated: false }), token)).toBeUndefined();
  });
});
