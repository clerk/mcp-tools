// Internal scope helpers for the MCP step-up scope challenge. Not part of the package exports.
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import type { McpScopeChallengeHandler } from './mcp-tool';

// An RFC 6749 scope-token: no space, `"`, `\`, or control character, so it fits a space-separated list and a quoted
// `WWW-Authenticate` value.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

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
function challengeScopes(
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
 * The `scopeChallenge` registration option for a tool that needs `required`. MCP SDK 2.1+ calls it before the tool
 * runs and answers with the 403 step-up challenge. A request without auth info is left to the tool.
 */
export function registrationScopeChallenge(required: readonly string[]): McpScopeChallengeHandler {
  return ({ authInfo }) => {
    if (authInfo === undefined) return undefined;
    const scopes = challengeScopes(required, authInfo);
    return scopes && { scopes };
  };
}
