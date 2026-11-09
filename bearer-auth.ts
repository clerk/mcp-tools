// The bearer-token rules that the Express and Hono adapters share. This module is not a package entry point.
import type { ClerkClient } from '@clerk/backend';
import type { MachineTokenVerificationErrorCode } from '@clerk/backend/errors';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { assertScopeTokens, challengeScopes } from './scope-challenge';
import { verifyClerkToken } from './server';

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
   * The scopes every request needs. A token without them gets a 403 `insufficient_scope` challenge.
   */
  requiredScopes?: readonly string[] | undefined;
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
  | { ok: true; authInfo: AuthInfo }
  | { ok: false; status: 401 | 403; challenge: string; error: string };

/** Throws a `Clerk error:` message when the options cannot produce a valid challenge. */
export function assertMcpAuthOptions(caller: string, options: McpAuthOptions | undefined) {
  assertScopeTokens(caller, 'requiredScopes', options?.requiredScopes ?? []);
  if (options?.resourceUrl !== undefined && !URL.canParse(options.resourceUrl)) {
    throw new Error(`Clerk error: ${caller} resourceUrl must be an absolute URL`);
  }
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
  if (scopes) params.push(`scope=${quoted(scopes.join(' '))}`);
  return `Bearer ${params.join(', ')}`;
}

// The token from a well-formed `Bearer <token>` header. The scheme is case-insensitive.
function parseBearerToken(header: string | undefined): string | undefined {
  const [scheme, token, ...rest] = header?.trim().split(/\s+/) ?? [];
  if (scheme?.toLowerCase() !== 'bearer' || rest.length > 0) return undefined;
  return token;
}

/**
 * Applies the response rule both adapters share. A missing or malformed header gets a bare challenge, a rejected token
 * adds `error="invalid_token"` (RFC 6750 section 3), and a token without `requiredScopes` gets a 403 with
 * `error="insufficient_scope"` (RFC 6750 section 3.1). The 403 `scope` is the granted scopes followed by the missing
 * ones, as in `requireAdditionalScopes`, so the new grant keeps the old access.
 */
export async function authenticateBearer({
  authorization,
  resourceMetadataUrl,
  requiredScopes = [],
  verifyToken,
}: {
  authorization: string | undefined;
  resourceMetadataUrl: string;
  requiredScopes: readonly string[] | undefined;
  verifyToken: (token: string) => Promise<AuthInfo | undefined>;
}): Promise<BearerResult> {
  const token = parseBearerToken(authorization);
  if (!token) {
    return {
      ok: false,
      status: 401,
      challenge: bearerChallenge({ resourceMetadataUrl }),
      error: 'Unauthorized',
    };
  }

  const authInfo = await verifyToken(token);
  if (!authInfo) {
    return {
      ok: false,
      status: 401,
      challenge: bearerChallenge({ resourceMetadataUrl, error: 'invalid_token' }),
      error: 'Unauthorized',
    };
  }

  const scopes = challengeScopes(requiredScopes, authInfo);
  if (scopes) {
    return {
      ok: false,
      status: 403,
      challenge: bearerChallenge({ resourceMetadataUrl, error: 'insufficient_scope', scopes }),
      error: 'insufficient_scope',
    };
  }

  return { ok: true, authInfo };
}

// The reasons Clerk gives when it could not verify a token at all, such as during an outage or with an invalid secret
// key, as opposed to when it rejected the token.
const verificationUnavailable: ReadonlySet<string> = new Set<MachineTokenVerificationErrorCode>([
  'unexpected-error',
  'secret-key-invalid',
]);

/**
 * Verifies an OAuth access token with Clerk, requiring `audience` in its `aud` claim. A token Clerk rejects resolves
 * to `undefined`, so that it reaches the client as an `invalid_token` challenge. When Clerk could not verify the token
 * at all, this throws instead and the framework answers with a server error: an `invalid_token` challenge would make
 * the client discard a valid token and restart authorization.
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
      throw new Error(`Clerk error: MCP access token verification failed: ${requestState.message}`);
    }
    return undefined;
  }
  return verifyClerkToken(requestState.toAuth(), token);
}
