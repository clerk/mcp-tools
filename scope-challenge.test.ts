import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { describe, expect, test } from 'vitest';

import { assertScopes, scopeChallengeFor } from './server';

function auth(scopes: string[] | undefined): AuthInfo {
  return { token: 't', clientId: 'client_1', scopes: scopes as string[] };
}

describe('scopeChallengeFor', () => {
  test('challenges for the granted scopes followed by the missing ones', () => {
    const challenge = scopeChallengeFor('projects:read', 'projects:write');
    expect(challenge({ authInfo: auth(['profile', 'projects:read']) })).toEqual({
      scopes: ['profile', 'projects:read', 'projects:write'],
    });
  });

  test('returns undefined when every required scope is granted', () => {
    const challenge = scopeChallengeFor('projects:read');
    expect(challenge({ authInfo: auth(['profile', 'projects:read']) })).toBeUndefined();
  });

  test('leaves a request without auth info to the tool', () => {
    expect(scopeChallengeFor('projects:read')({})).toBeUndefined();
  });

  test('treats auth info without scopes as granting none', () => {
    expect(scopeChallengeFor('projects:read')({ authInfo: auth(undefined) })).toEqual({
      scopes: ['projects:read'],
    });
  });

  test('drops a granted scope that is not a scope-token', () => {
    const challenge = scopeChallengeFor('projects:read');
    expect(challenge({ authInfo: auth(['bad"scope', 'profile']) })).toEqual({
      scopes: ['profile', 'projects:read'],
    });
  });

  test.each([['a b'], [''], ['a"b'], ['a\\b']])(
    'throws for the invalid required scope %j',
    (scope) => {
      expect(() => scopeChallengeFor('projects:read', scope)).toThrow(
        /^Clerk error: scopeChallengeFor requiredScopes must contain only scope tokens/,
      );
    },
  );

  test('exposes its scopes, frozen so they cannot change the challenge', () => {
    const challenge = scopeChallengeFor('projects:read');
    expect(challenge.requiredScopes).toEqual(['projects:read']);
    expect(Object.isFrozen(challenge.requiredScopes)).toBe(true);
  });

  test('does not let its scopes be replaced, so assertScopes checks what the challenge checks', () => {
    const challenge = scopeChallengeFor('projects:read');
    expect(() => {
      (challenge as { requiredScopes: readonly string[] }).requiredScopes = ['profile'];
    }).toThrow(TypeError);
    expect(() => assertScopes({ authInfo: auth(['profile']) }, challenge)).toThrow(
      'The token is missing required scopes: projects:read',
    );
  });

  test('throws when given no scopes', () => {
    expect(() => scopeChallengeFor()).toThrow(
      /^Clerk error: scopeChallengeFor needs at least one scope/,
    );
  });

  test('throws when given an array instead of separate scopes', () => {
    // @ts-expect-error scopes are separate arguments
    expect(() => scopeChallengeFor(['projects:read'])).toThrow(
      /^Clerk error: scopeChallengeFor requiredScopes must contain only scope tokens/,
    );
  });
});

describe('assertScopes', () => {
  test('passes when the MCP SDK 2.x context has every required scope', () => {
    expect(() =>
      assertScopes({ http: { authInfo: auth(['profile', 'projects:read']) } }, 'projects:read'),
    ).not.toThrow();
  });

  test('passes when the MCP SDK 1.x extra has every required scope', () => {
    expect(() =>
      assertScopes({ authInfo: auth(['projects:read']) }, 'projects:read'),
    ).not.toThrow();
  });

  test('throws naming only the missing scopes', () => {
    expect(() =>
      assertScopes(
        { http: { authInfo: auth(['projects:read']) } },
        'projects:read',
        'projects:write',
        'teams:read',
      ),
    ).toThrow(
      'The token is missing required scopes: projects:write, teams:read. Reconnect to approve them.',
    );
  });

  test('checks the scopes of a scopeChallengeFor result', () => {
    const projectsRead = scopeChallengeFor('projects:read', 'projects:write');
    expect(() =>
      assertScopes({ authInfo: auth(['projects:read', 'projects:write']) }, projectsRead),
    ).not.toThrow();
    expect(() => assertScopes({ authInfo: auth(['projects:read']) }, projectsRead)).toThrow(
      'The token is missing required scopes: projects:write',
    );
  });

  test('throws a Clerk error for a challenge that is not from scopeChallengeFor', () => {
    const sdkChallenge = () => undefined;
    // @ts-expect-error only scopeChallengeFor results carry their scopes
    expect(() => assertScopes({ authInfo: auth([]) }, sdkChallenge)).toThrow(
      /^Clerk error: assertScopes requiredScopes must contain only scope tokens/,
    );
  });

  test('throws when the call has no auth info', () => {
    expect(() => assertScopes({}, 'projects:read')).toThrow(
      'This tool needs an access token with these scopes: projects:read',
    );
  });

  test('treats auth info without scopes as granting none', () => {
    expect(() => assertScopes({ authInfo: auth(undefined) }, 'projects:read')).toThrow(
      'The token is missing required scopes: projects:read',
    );
  });

  test('throws a Clerk error when given no scopes or an invalid scope', () => {
    expect(() => assertScopes({ authInfo: auth([]) })).toThrow(
      /^Clerk error: assertScopes needs at least one scope/,
    );
    expect(() => assertScopes({ authInfo: auth([]) }, 'a b')).toThrow(
      /^Clerk error: assertScopes requiredScopes must contain only scope tokens/,
    );
  });
});
