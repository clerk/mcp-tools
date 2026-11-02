// Internal MCP step-up scope challenge shared by the adapters. Only `scopeChallenge` and `ToolScopes` are
// re-exported, from `@clerk/mcp-tools/server`; this module is not part of the package exports.
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/** The OAuth scopes each tool needs, by tool name. A tool that is not listed needs none. */
export type ToolScopes = Readonly<Record<string, readonly string[]>>;

// An RFC 6749 scope-token: no space, `"`, `\`, or control character, so it fits a space-separated list and a quoted
// `WWW-Authenticate` value.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** Whether `scope` is a valid OAuth scope-token. */
export function isScopeToken(scope: unknown): scope is string {
  return typeof scope === 'string' && SCOPE_TOKEN.test(scope);
}

/** Throws a `Clerk error:` message when `scopes` has a value that is not a scope-token. */
export function assertScopeTokens(caller: string, option: string, scopes: Iterable<unknown>) {
  if (![...scopes].every(isScopeToken)) {
    throw new Error(
      `Clerk error: ${caller} ${option} must contain only scope tokens: no empty strings, spaces, quotes, backslashes, or control characters`,
    );
  }
}

/** Throws a `Clerk error:` message when a scope in `toolScopes` is not a scope-token. */
export function assertToolScopes(caller: string, toolScopes: ToolScopes) {
  assertScopeTokens(caller, 'toolScopes', Object.values(toolScopes).flat());
}

type ScopeChallengeParams = {
  body: unknown;
  authInfo: AuthInfo;
  toolScopes: ToolScopes;
  resourceMetadataUrl: string;
};

// A custom verifier can return auth info without `scopes`; that grants none, so the checks fail closed.
function grantedScopes(authInfo: AuthInfo): string[] {
  return Array.isArray(authInfo.scopes) ? authInfo.scopes : [];
}

/** The `required` scopes that `authInfo` lacks. The scope challenge and the tools' own checks share this rule. */
export function missingScopes(required: Iterable<string>, authInfo: AuthInfo): string[] {
  const granted = grantedScopes(authInfo);
  return [...required].filter((scope) => !granted.includes(scope));
}

// Names of the tools that a parsed JSON-RPC message, or batch of messages, calls with `tools/call`.
function toolCallNames(body: unknown): string[] {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    if (typeof message !== 'object' || message === null) return [];
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method !== 'tools/call' || typeof params !== 'object' || params === null) return [];
    const { name } = params as { name?: unknown };
    return typeof name === 'string' ? [name] : [];
  });
}

/**
 * The `WWW-Authenticate` value of the 403 step-up challenge when `body` calls a tool that needs scopes `authInfo`
 * lacks, and `undefined` otherwise. The challenged scopes are the granted ones followed by the missing ones, so the
 * new grant keeps the old access.
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#scope-challenge-handling
 */
export function scopeChallengeHeader({
  body,
  authInfo,
  toolScopes,
  resourceMetadataUrl,
}: ScopeChallengeParams): string | undefined {
  // The tool name comes from the request, so only own keys count: `constructor` or `__proto__` must not reach Object.prototype.
  const required = new Set(
    toolCallNames(body).flatMap((name) =>
      Object.hasOwn(toolScopes, name) ? toolScopes[name] : [],
    ),
  );
  const missing = missingScopes(required, authInfo);
  if (missing.length === 0) return undefined;
  const scopes = [...new Set([...grantedScopes(authInfo), ...missing])];
  return `Bearer error="insufficient_scope", scope="${scopes.join(' ')}", resource_metadata="${resourceMetadataUrl}"`;
}

/**
 * A 403 step-up challenge when `body` calls a tool that needs scopes `authInfo` lacks, keeping the granted scopes.
 * Call it before the transport handles the request: a tool handler cannot change the HTTP status.
 */
export function scopeChallenge(params: ScopeChallengeParams): Response | undefined {
  assertToolScopes('scopeChallenge', params.toolScopes);
  const header = scopeChallengeHeader(params);
  if (header === undefined) return undefined;
  return Response.json(
    { error: 'Forbidden' },
    { status: 403, headers: { 'WWW-Authenticate': header } },
  );
}
