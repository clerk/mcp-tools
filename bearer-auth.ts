// The bearer-token rules that the Express and Hono adapters share. This module is not a package entry point.
import type { ClerkClient } from '@clerk/backend';
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
   * from the public URL behind a proxy.
   */
  resourceUrl?: string | undefined;
  /**
   * The scopes every request needs. A token without them gets a 403 `insufficient_scope` challenge.
   */
  requiredScopes?: readonly string[] | undefined;
};

/**
 * Options for the `clerkMcpAuth` middleware.
 */
export type ClerkMcpAuthOptions = McpAuthOptions & {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`. Clerk rejects a token
   * whose `aud` claim does not include it, and the challenge's `resource_metadata` is derived from it.
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

/**
 * Verifies an OAuth access token with Clerk, requiring `audience` in its `aud` claim. A verification failure is logged
 * and treated as a rejected token, so that it reaches the client as a challenge.
 */
export async function verifyClerkOAuthToken(
  client: Pick<ClerkClient, 'authenticateRequest'>,
  token: string,
  audience: string,
) {
  try {
    const requestState = await client.authenticateRequest(
      new Request(audience, { headers: { authorization: `Bearer ${token}` } }),
      { acceptsToken: 'oauth_token', audience },
    );
    if (!requestState.isAuthenticated) return undefined;
    return verifyClerkToken(requestState.toAuth(), token);
  } catch (error) {
    console.error('Clerk error: MCP access token verification failed', error);
    return undefined;
  }
}
