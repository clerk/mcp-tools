// Scope helpers for the MCP step-up scope challenge. Only `scopeChallengeFor` and `assertScopes` are public,
// re-exported from `@clerk/mcp-tools/server`. This module is not a package entry point.
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

// Assignable to the SDK 2.1+ `ScopeChallengeHandler`, which this package cannot import: SDK 2.x is not a dependency.
type ScopeChallengeHandler = (context: {
  authInfo?: AuthInfo;
}) => { scopes: readonly [string, ...string[]] } | undefined;

type ScopeChallenge = ScopeChallengeHandler & { readonly requiredScopes: readonly string[] };

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
 * The `scopeChallenge` registration option for a tool that needs `requiredScopes`. MCP SDK 2.1+ calls it before the
 * tool runs and answers with the 403 step-up challenge for the granted scopes followed by the missing ones, so the
 * new grant keeps the old access. A request without auth info is left to the tool. MCP SDK 1.x has no such option.
 * Pass `resourceMetadataUrl` on `authInfo` so that the challenge carries `resource_metadata`.
 * The result also carries `requiredScopes`, so `assertScopes(ctx, result)` checks the same scopes in the tool.
 * Throws a `Clerk error:` message when no scope is given or a scope is not a scope-token.
 * @example
 * server.registerTool('list_projects', { title, description, inputSchema, scopeChallenge: scopeChallengeFor('projects:read') }, handler);
 */
export function scopeChallengeFor(...requiredScopes: string[]): ScopeChallenge {
  assertRequiredScopes('scopeChallengeFor', requiredScopes);
  // Frozen and read-only on the result: `assertScopes` reads it, so a change would check other scopes than the challenge.
  const required = Object.freeze(requiredScopes);
  const challenge: ScopeChallengeHandler = ({ authInfo }) => {
    if (authInfo === undefined) return undefined;
    const scopes = challengeScopes(required, authInfo);
    return scopes && { scopes };
  };
  return Object.defineProperty(challenge, 'requiredScopes', {
    value: required,
    enumerable: true,
  }) as ScopeChallenge;
}

function isScopeChallenge(value: unknown): value is ScopeChallenge {
  return typeof value === 'function' && Array.isArray((value as ScopeChallenge).requiredScopes);
}

/** The second argument of a tool callback: `RequestHandlerExtra` on MCP SDK 1.x, `ServerContext` on 2.x. */
type ToolCallContext = { authInfo?: AuthInfo; http?: { authInfo?: AuthInfo } };

/**
 * Throws when the tool call's access token lacks any of the required scopes, given as the result of
 * `scopeChallengeFor` or as separate arguments. MCP SDK 1.x and 2.x turn the error into a tool error whose text names
 * the missing scopes. Call it at the start of a tool: the `scopeChallengeFor` challenge only takes effect over HTTP on
 * SDK 2.1+ and for requests with auth info.
 * Throws a `Clerk error:` message when no scope is given or a scope is not a scope-token.
 * @example
 * const projectsRead = scopeChallengeFor('projects:read');
 * server.registerTool('list_projects', { scopeChallenge: projectsRead }, async (args, ctx) => {
 *   assertScopes(ctx, projectsRead);
 *   // ...
 * });
 */
export function assertScopes(context: ToolCallContext, challenge: ScopeChallenge): void;
export function assertScopes(context: ToolCallContext, ...requiredScopes: string[]): void;
export function assertScopes(context: ToolCallContext, ...scopes: unknown[]): void {
  const [first] = scopes;
  const requiredScopes =
    scopes.length === 1 && isScopeChallenge(first) ? first.requiredScopes : scopes;
  assertRequiredScopes('assertScopes', requiredScopes);
  const authInfo = context.http?.authInfo ?? context.authInfo;
  if (authInfo === undefined) {
    throw new Error(
      `This tool needs an access token with these scopes: ${requiredScopes.join(', ')}`,
    );
  }
  const missing = missingScopes(requiredScopes, authInfo);
  if (missing.length > 0) {
    throw new Error(
      `The token is missing required scopes: ${missing.join(', ')}. Reconnect to approve them.`,
    );
  }
}

function assertRequiredScopes(
  caller: string,
  requiredScopes: readonly unknown[],
): asserts requiredScopes is readonly string[] {
  if (requiredScopes.length === 0) {
    throw new Error(`Clerk error: ${caller} needs at least one scope`);
  }
  assertScopeTokens(caller, 'requiredScopes', requiredScopes);
}
