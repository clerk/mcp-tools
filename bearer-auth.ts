// The bearer-token rules that the Express, Hono, and Next.js adapters share. This module is not a package entry point.
import type { ClerkClient } from '@clerk/backend';
import type { MachineTokenVerificationErrorCode } from '@clerk/backend/errors';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { assertScopeTokens, challengeScopes } from './scope-challenge';
import { verifyClerkToken } from './server';

/**
 * Why `mcpAuth` answered a request with a 401 or 403 challenge. The adapters record it on the request context, such
 * as Express `res.locals.mcpAuthFailure` or Hono `c.get('mcpAuthFailure')`, for example for logging.
 */
export type McpAuthFailure = {
  reason: 'missing_token' | 'malformed_token' | 'invalid_token' | 'insufficient_scope';
};

/**
 * Thrown by `mcpAuth` and `mcpAuthClerk` when the token could not be verified at all, such as when the verifier
 * throws or Clerk is unreachable, so the request reaches the framework's error handler instead of a challenge that
 * would make the client discard a valid token. The verifier's error is the `cause`.
 */
export class McpAuthError extends Error {
  readonly reason = 'verification_failed';
  /** The `cause`'s numeric `status`, if any, so Express's default error handler still answers with it. */
  readonly status: number | undefined;

  constructor(cause: unknown) {
    super('Clerk error: MCP access token verification failed', { cause });
    this.name = 'McpAuthError';
    const status = (cause as { status?: unknown } | null)?.status;
    this.status = typeof status === 'number' ? status : undefined;
  }
}

/**
 * Options for the `mcpAuth` middleware.
 */
export type McpAuthOptions = {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`. The challenge's
   * `resource_metadata` is derived from it. When omitted, it is derived from the incoming request, which can differ
   * from the public URL behind a proxy. Set the protected resource metadata route's `resource` to the same URL, since
   * that route also derives it from the request.
   */
  resourceUrl?: string | undefined;
  /**
   * The scopes every request needs. A token without them gets a 403 `insufficient_scope` challenge, and the 401
   * challenge lists them in its `scope`.
   */
  requiredScopes?: readonly string[] | undefined;
  /**
   * More scopes for the 401 challenge's `scope`, after `requiredScopes`, such as the scopes individual tools step up
   * to. MCP clients request the 401 challenge's `scope` when they first authorize, so listing them saves a later
   * step-up. A token is not required to have them.
   */
  challengeScopes?: readonly string[] | undefined;
};

/**
 * Options for the `mcpAuthClerk` middleware.
 */
export type McpAuthClerkOptions = McpAuthOptions & {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`. Clerk rejects a token
   * whose `aud` claim does not include it, and the challenge's `resource_metadata` is derived from it. Set the
   * protected resource metadata route's `resource` to the same URL, since that route derives it from the request.
   */
  resourceUrl: string;
};

type BearerResult =
  | { ok: true; authInfo: AuthInfo & { resourceMetadataUrl: string } }
  | { ok: false; failure: McpAuthFailure; status: 401 | 403; challenge: string; error: string };

/** Throws a `Clerk error:` message when the options cannot produce a valid challenge. */
export function assertMcpAuthOptions(caller: string, options: McpAuthOptions | undefined) {
  assertScopeTokens(caller, 'requiredScopes', options?.requiredScopes ?? []);
  assertScopeTokens(caller, 'challengeScopes', options?.challengeScopes ?? []);
  if (options?.resourceUrl !== undefined && !isResourceUrl(options.resourceUrl)) {
    throw new Error(
      `Clerk error: ${caller} resourceUrl must be an absolute http or https URL without credentials`,
    );
  }
}

// A URL with another scheme, such as `mailto:`, has no origin for the challenge, and `new Request` throws on a URL with
// credentials.
function isResourceUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
}

/**
 * Throws a `Clerk error:` message unless `options` has a `resourceUrl`. Code written for the earlier `mcpAuthClerk`,
 * which was the middleware itself, passes it straight to a route, so the framework calls it with the request where
 * the options belong. Without this check that call would quietly return a middleware and the request would hang.
 */
export function assertMcpAuthClerkOptions(options: McpAuthClerkOptions) {
  if (typeof options?.resourceUrl !== 'string') {
    throw new Error(
      "Clerk error: mcpAuthClerk needs a resourceUrl. Call it as mcpAuthClerk({ resourceUrl: 'https://mcp.example.com/mcp' }) instead of passing mcpAuthClerk to the route directly",
    );
  }
  assertMcpAuthOptions('mcpAuthClerk', options);
}

/** The RFC 9728 metadata URL for a resource: the well-known path goes between the host and the resource's path. */
export function resourceMetadataUrlFor(resourceUrl: string): string {
  const { origin, pathname } = new URL(resourceUrl);
  return `${origin}/.well-known/oauth-protected-resource${pathname === '/' ? '' : pathname}`;
}

// An RFC 9110 `auth-param` value here is a `quoted-string`: a URL's `:` and `/` are not allowed in a bare token.
function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function bearerChallenge({
  resourceMetadataUrl,
  error,
  scopes,
}: {
  resourceMetadataUrl: string;
  error?: 'invalid_token' | 'insufficient_scope';
  scopes?: readonly string[];
}): string {
  const params = [`resource_metadata=${quoted(resourceMetadataUrl)}`];
  if (error) params.push(`error=${quoted(error)}`);
  if (scopes && scopes.length > 0) params.push(`scope=${quoted(scopes.join(' '))}`);
  return `Bearer ${params.join(', ')}`;
}

type ParsedAuthorization = { token: string } | { reason: 'missing_token' | 'malformed_token' };

// The token from a well-formed `Bearer <token>` header. The scheme is case-insensitive.
function parseAuthorization(header: string | undefined): ParsedAuthorization {
  if (!header?.trim()) return { reason: 'missing_token' };
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    return { reason: 'malformed_token' };
  }
  return { token };
}

/**
 * Applies the response rule the adapters share. A missing or malformed header gets a challenge without an error code,
 * a rejected token adds `error="invalid_token"` (RFC 6750 section 3), and both 401 challenges list `requiredScopes`
 * then `challengeScopes` in `scope` (RFC 6750 section 3). A token without `requiredScopes` gets a 403 with
 * `error="insufficient_scope"` (RFC 6750 section 3.1). The 403 `scope` is the granted scopes followed by the missing
 * ones, as in `requireAdditionalScopes`, so the new grant keeps the old access. A verified token's auth info gets
 * `resourceMetadataUrl`, which MCP SDK 2 puts in the `resource_metadata` of its own scope challenges. A verifier that
 * throws gets its error wrapped in an `McpAuthError`.
 */
export async function authenticateBearer({
  authorization,
  resourceMetadataUrl,
  requiredScopes = [],
  challengeScopes: extraChallengeScopes = [],
  verifyToken,
}: {
  authorization: string | undefined;
  resourceMetadataUrl: string;
  requiredScopes: readonly string[] | undefined;
  challengeScopes: readonly string[] | undefined;
  verifyToken: (token: string) => Promise<AuthInfo | undefined>;
}): Promise<BearerResult> {
  const unauthorizedScopes = [...new Set([...requiredScopes, ...extraChallengeScopes])];

  const parsed = parseAuthorization(authorization);
  if ('reason' in parsed) {
    return {
      ok: false,
      failure: { reason: parsed.reason },
      status: 401,
      challenge: bearerChallenge({ resourceMetadataUrl, scopes: unauthorizedScopes }),
      error: 'Unauthorized',
    };
  }

  let authInfo: AuthInfo | undefined;
  try {
    authInfo = await verifyToken(parsed.token);
  } catch (error) {
    throw new McpAuthError(error);
  }

  if (!authInfo) {
    return {
      ok: false,
      failure: { reason: 'invalid_token' },
      status: 401,
      challenge: bearerChallenge({
        resourceMetadataUrl,
        error: 'invalid_token',
        scopes: unauthorizedScopes,
      }),
      error: 'Unauthorized',
    };
  }

  const scopes = challengeScopes(requiredScopes, authInfo);
  if (scopes) {
    return {
      ok: false,
      failure: { reason: 'insufficient_scope' },
      status: 403,
      challenge: bearerChallenge({ resourceMetadataUrl, error: 'insufficient_scope', scopes }),
      error: 'insufficient_scope',
    };
  }

  // MCP SDK 2 reads `resourceMetadataUrl` from the auth info for the challenges its `scopeChallenge` tools send
  return { ok: true, authInfo: { ...authInfo, resourceMetadataUrl } };
}

// The reasons Clerk gives when it could not verify a token at all, such as during an outage or with an invalid secret
// key, as opposed to when it rejected the token. A JWT access token whose JWKS cannot be fetched gets
// `token-verification-failed` instead, the reason an invalid signature gets, so that case still resolves as rejected.
const verificationUnavailable: ReadonlySet<string> = new Set<MachineTokenVerificationErrorCode>([
  'unexpected-error',
  'secret-key-invalid',
]);

/**
 * Verifies an OAuth access token with Clerk, requiring `audience` in its `aud` claim. A token Clerk rejects resolves
 * to `undefined`, so that it reaches the client as an `invalid_token` challenge. When Clerk could not verify an opaque
 * token at all, this throws instead and the framework answers with a server error: an `invalid_token` challenge would
 * make the client discard a valid token and restart authorization. Clerk does not report a JWKS failure on a JWT access
 * token separately from an invalid signature, so that case still resolves to `undefined`.
 */
export async function verifyClerkOAuthToken(
  client: Pick<ClerkClient, 'authenticateRequest'>,
  token: string,
  audience: string,
) {
  const requestState = await client.authenticateRequest(
    new Request(audience, { headers: { authorization: `Bearer ${token}` } }),
    { acceptsToken: 'oauth_token', audience },
  );
  if (!requestState.isAuthenticated) {
    if (verificationUnavailable.has(requestState.reason)) {
      throw new Error(
        `Clerk could not verify the token (${requestState.reason}): ${requestState.message}`,
      );
    }
    return undefined;
  }
  return verifyClerkToken(requestState.toAuth(), token);
}
