import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { describe, expect, test } from 'vitest';

import { requireAdditionalScopes } from './server';

function auth(scopes: string[] | undefined): AuthInfo {
  return { token: 't', clientId: 'client_1', scopes: scopes as string[] };
}

describe('requireAdditionalScopes', () => {
  test('challenges for the granted scopes followed by the missing ones', () => {
    const challenge = requireAdditionalScopes('projects:read', 'projects:write');
    expect(challenge({ authInfo: auth(['profile', 'projects:read']) })).toEqual({
      scopes: ['profile', 'projects:read', 'projects:write'],
    });
  });

  test('returns undefined when every required scope is granted', () => {
    const challenge = requireAdditionalScopes('projects:read');
    expect(challenge({ authInfo: auth(['profile', 'projects:read']) })).toBeUndefined();
  });

  test('leaves a request without auth info to the tool', () => {
    expect(requireAdditionalScopes('projects:read')({})).toBeUndefined();
  });

  test('treats auth info without scopes as granting none', () => {
    expect(requireAdditionalScopes('projects:read')({ authInfo: auth(undefined) })).toEqual({
      scopes: ['projects:read'],
    });
  });

  test('drops a granted scope that is not a scope-token', () => {
    const challenge = requireAdditionalScopes('projects:read');
    expect(challenge({ authInfo: auth(['bad"scope', 'profile']) })).toEqual({
      scopes: ['profile', 'projects:read'],
    });
  });

  test.each([['a b'], [''], ['a"b'], ['a\\b']])(
    'throws for the invalid required scope %j',
    (scope) => {
      expect(() => requireAdditionalScopes('projects:read', scope)).toThrow(
        /^Clerk error: requireAdditionalScopes requiredScopes must contain only scope tokens/,
      );
    },
  );

  test('throws when given no scopes', () => {
    // @ts-expect-error at least one scope is required
    expect(() => requireAdditionalScopes()).toThrow(
      /^Clerk error: requireAdditionalScopes needs at least one scope/,
    );
  });

  test('throws when given an array instead of separate scopes', () => {
    // @ts-expect-error scopes are separate arguments
    expect(() => requireAdditionalScopes(['projects:read'])).toThrow(
      /^Clerk error: requireAdditionalScopes requiredScopes must contain only scope tokens/,
    );
  });
});
