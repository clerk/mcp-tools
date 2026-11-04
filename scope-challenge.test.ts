import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { describe, expect, test } from 'vitest';

import { scopeChallengeFor } from './server';

function auth(scopes: string[] | undefined): AuthInfo {
  return { token: 't', clientId: 'client_1', scopes: scopes as string[] };
}

describe('scopeChallengeFor', () => {
  test('challenges for the granted scopes followed by the missing ones', () => {
    const challenge = scopeChallengeFor(['projects:read', 'projects:write']);
    expect(challenge({ authInfo: auth(['profile', 'projects:read']) })).toEqual({
      scopes: ['profile', 'projects:read', 'projects:write'],
    });
  });

  test('returns undefined when every required scope is granted', () => {
    const challenge = scopeChallengeFor(['projects:read']);
    expect(challenge({ authInfo: auth(['profile', 'projects:read']) })).toBeUndefined();
  });

  test('returns undefined when nothing is required', () => {
    expect(scopeChallengeFor([])({ authInfo: auth([]) })).toBeUndefined();
  });

  test('leaves a request without auth info to the tool', () => {
    expect(scopeChallengeFor(['projects:read'])({})).toBeUndefined();
  });

  test('treats auth info without scopes as granting none', () => {
    expect(scopeChallengeFor(['projects:read'])({ authInfo: auth(undefined) })).toEqual({
      scopes: ['projects:read'],
    });
  });

  test('drops a granted scope that is not a scope-token', () => {
    const challenge = scopeChallengeFor(['projects:read']);
    expect(challenge({ authInfo: auth(['bad"scope', 'profile']) })).toEqual({
      scopes: ['profile', 'projects:read'],
    });
  });

  test.each([[['a b']], [['']], [['a"b']], [['a\\b']]])(
    'throws for the invalid required scopes %j',
    (scopes) => {
      expect(() => scopeChallengeFor(scopes)).toThrow(
        /^Clerk error: scopeChallengeFor requiredScopes must contain only scope tokens/,
      );
    },
  );

  test('keeps the scopes it was created with when the caller empties the array', () => {
    const scopes = ['projects:read'];
    const challenge = scopeChallengeFor(scopes);
    scopes.length = 0;
    expect(challenge({ authInfo: auth(['profile']) })).toEqual({
      scopes: ['profile', 'projects:read'],
    });
  });

  test('throws for a required scopes value that is not an array', () => {
    expect(() => scopeChallengeFor('projects:read' as never)).toThrow(
      /^Clerk error: scopeChallengeFor requiredScopes must be an array/,
    );
  });
});
