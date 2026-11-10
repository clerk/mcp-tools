// Scope helpers for the MCP step-up scope challenge. Only `requireAdditionalScopes` is public, re-exported from
// `@clerk/mcp-tools/server`. This module is not a package entry point.
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

// Assignable to the SDK 2.1+ `ScopeChallengeHandler`, which this package cannot import: SDK 2.x is not a dependency.
type ScopeChallengeHandler = (context: {
  authInfo?: AuthInfo;
}) => { scopes: readonly [string, ...string[]] } | undefined;

// An RFC 6749 scope-token: no space, `"`, `\`, or control character, so it fits a space-separated list and a quoted
// `WWW-Authenticate` value.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

type Chars<S extends string> = S extends `${infer C}${infer R}` ? C | Chars<R> : never;

type LowercaseLetter = Chars<'abcdefghijklmnopqrstuvwxyz'>;

// The characters `SCOPE_TOKEN` allows.
type ScopeTokenChar =
  | LowercaseLetter
  | Uppercase<LowercaseLetter>
  | Chars<'0123456789'>
  | Chars<"!#$%&'()*+,-./:;<=>?@[]^_`{|}~">;

type HasOnlyScopeTokenChars<S extends string> = S extends `${infer C}${infer R}`
  ? C extends ScopeTokenChar
    ? HasOnlyScopeTokenChars<R>
    : false
  : true;

// A wide `string` passes: only literals can be checked before run time.
type ScopeToken<S extends string> = string extends S
  ? S
  : S extends ''
    ? `invalid scope token: ${S}`
    : HasOnlyScopeTokenChars<S> extends true
      ? S
      : `invalid scope token: ${S}`;

type ScopeTokens<T extends readonly string[]> = { [K in keyof T]: ScopeToken<T[K]> };

function isScopeToken(scope: unknown): scope is string {
  return typeof scope === 'string' && SCOPE_TOKEN.test(scope);
}

/** Throws a `Clerk error:` message when `scopes` has a value that is not a scope-token. */
export function assertScopeTokens(caller: string, option: string, scopes: readonly unknown[]) {
  if (!scopes.every(isScopeToken)) {
    throw new Error(
      `Clerk error: ${caller} ${option} must contain only scope tokens: no empty strings, spaces, quotes, backslashes, or control characters`,
    );
  }
}

// A custom verifier can return auth info without `scopes`; that grants none, so the checks fail closed.
function grantedScopes(authInfo: AuthInfo): string[] {
  return Array.isArray(authInfo.scopes) ? authInfo.scopes : [];
}

/** The `required` scopes that `authInfo` lacks. The scope challenge and the tools' own checks share this rule. */
export function missingScopes(required: readonly string[], authInfo: AuthInfo): string[] {
  const granted = grantedScopes(authInfo);
  return required.filter((scope) => !granted.includes(scope));
}

/**
 * The scopes to challenge for when `authInfo` lacks some of `required`, and `undefined` otherwise: the granted ones
 * followed by the missing ones, so the new grant keeps the old access.
 */
export function stepUpScopes(
  required: readonly string[],
  authInfo: AuthInfo,
): [string, ...string[]] | undefined {
  const missing = missingScopes(required, authInfo);
  if (missing.length === 0) return undefined;
  // A malformed granted scope is dropped: it would break the quoted header, and the SDK throws on the whole challenge.
  const granted = grantedScopes(authInfo).filter(isScopeToken);
  return [...new Set([...granted, ...missing])] as [string, ...string[]];
}

/**
 * The `scopeChallenge` registration option for a tool that needs `requiredScopes`. MCP SDK 2.1+ calls it before the
 * tool runs and answers with the 403 step-up challenge for the granted scopes followed by the missing ones, so the
 * new grant keeps the old access. A request without auth info is left to the tool. MCP SDK 1.x has no such option.
 * Pass `resourceMetadataUrl` on `authInfo` so that the challenge carries `resource_metadata`.
 * Throws a `Clerk error:` message when no scope is given or a scope is not a scope-token.
 * @example
 * server.registerTool('list_projects', { title, description, inputSchema, scopeChallenge: requireAdditionalScopes('projects:read') }, handler);
 */
export function requireAdditionalScopes<const T extends readonly [string, ...string[]]>(
  ...requiredScopes: ScopeTokens<T>
): ScopeChallengeHandler {
  if (requiredScopes.length === 0) {
    throw new Error('Clerk error: requireAdditionalScopes needs at least one scope');
  }
  assertScopeTokens('requireAdditionalScopes', 'requiredScopes', requiredScopes);
  return ({ authInfo }) => {
    if (authInfo === undefined) return undefined;
    const scopes = stepUpScopes(requiredScopes, authInfo);
    return scopes && { scopes };
  };
}
