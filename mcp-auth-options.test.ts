import { describe, expect, test } from 'vitest';

import { tokenMatchesAudience } from './mcp-auth-options';
import { jwtWith } from './test/jwt';

const RESOURCE = 'https://mcp.example.com/mcp';

describe('tokenMatchesAudience', () => {
  test.each([
    ['a matching string', RESOURCE, RESOURCE, true],
    ['a matching entry of an array', [RESOURCE, 'other'], RESOURCE, true],
    ['an overlap with an accepted list', [RESOURCE], [RESOURCE, 'x'], true],
    ['another resource', 'https://other.example.com/mcp', RESOURCE, false],
    ['no overlap in an array', ['a', 'b'], RESOURCE, false],
    ['an empty string', '', RESOURCE, false],
    ['an empty array', [], RESOURCE, false],
    ['an array with an empty entry', [RESOURCE, ''], RESOURCE, false],
    ['a non-string entry', [RESOURCE, 5], RESOURCE, false],
    ['a number', 5, RESOURCE, false],
    ['null', null, RESOURCE, false],
  ])('a JWT with %s as aud', (_name, aud, audience, expected) => {
    expect(tokenMatchesAudience(jwtWith({ aud }), audience as string | string[])).toBe(expected);
  });

  test('refuses a JWT without aud', () => {
    expect(tokenMatchesAudience(jwtWith({ sub: 'user_1' }), RESOURCE)).toBe(false);
  });

  test('refuses a JWT-shaped token whose payload cannot be read', () => {
    expect(tokenMatchesAudience('a.!!!.c', RESOURCE)).toBe(false);
    expect(tokenMatchesAudience(`a.${Buffer.from('nope').toString('base64url')}.c`, RESOURCE)).toBe(
      false,
    );
  });

  test('leaves an opaque token to Clerk', () => {
    expect(tokenMatchesAudience('oat_opaque_token', RESOURCE)).toBe(true);
  });
});
