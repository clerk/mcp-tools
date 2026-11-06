import { describe, test } from 'vitest';

import { requireAdditionalScopes } from './server';

describe('requireAdditionalScopes types', () => {
  test('accepts scope-token literals', () => {
    requireAdditionalScopes('projects:read');
    requireAdditionalScopes('profile', 'openid', 'org:read:members');
    requireAdditionalScopes("!#$%&'()*+,-./:;<=>?@[]^_`{|}~");
  });

  test('accepts scopes it cannot check before run time', () => {
    const wide: string = 'projects:read';
    const template = `projects:${wide}` as const;
    const tuple: readonly [string, ...string[]] = ['projects:read'];
    const asConst = ['projects:read', 'email'] as const;
    requireAdditionalScopes(wide);
    requireAdditionalScopes(template);
    requireAdditionalScopes(...tuple);
    requireAdditionalScopes(...asConst);
  });

  test('rejects a literal that is not a scope-token', () => {
    // @ts-expect-error empty
    requireAdditionalScopes('');
    // @ts-expect-error space
    requireAdditionalScopes('projects read');
    // @ts-expect-error quote
    requireAdditionalScopes('projects"read');
    // @ts-expect-error backslash
    requireAdditionalScopes('projects\\read');
    // @ts-expect-error control character
    requireAdditionalScopes('projects\nread');
    // @ts-expect-error non-ASCII
    requireAdditionalScopes('café');
    // @ts-expect-error only the second scope is invalid
    requireAdditionalScopes('projects:read', 'projects write');
    // @ts-expect-error invalid inside an `as const` tuple
    requireAdditionalScopes(...(['projects:read', 'projects write'] as const));
  });

  test('rejects calls without at least one scope', () => {
    const scopes: string[] = ['projects:read'];
    // @ts-expect-error no scopes
    requireAdditionalScopes();
    // @ts-expect-error a plain array may be empty
    requireAdditionalScopes(...scopes);
    // @ts-expect-error scopes are separate arguments
    requireAdditionalScopes(['projects:read']);
  });
});
