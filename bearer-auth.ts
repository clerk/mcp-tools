// The bearer-token rules that the Express, Hono, and Next.js adapters share. This module is not a package entry point.
import type { MachineTokenVerificationErrorCode } from '@clerk/backend/errors';
import type { AuthInfo } from './mcp-types';
import { assertScopeTokens, challengeScopes } from './scope-challenge';
import {
  type ClerkOAuthClient,
  type McpAuthFailure,
  type McpResourceUrl,
  McpAuthError,
  McpTokenVerificationError,
  matchResourceUrl,
  toClerkAuthInfo,
} from './server';

/**
 * Options for the `mcpAuth` middleware.
 */
export type McpAuthOptions = {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one
   * for each origin the server answers on. A request uses the listed URL with its origin, and a request to any other
   * origin gets a 421. The request's origin is the one the app sees, so behind a proxy that terminates TLS or rewrites
   * `Host`, list those URLs or, in Express, set `trust proxy`. The challenge's `resource_metadata` is derived from it. When omitted, it is derived from the
   * incoming request, which can differ from the public URL behind a proxy. Set the protected resource metadata route's
   * `resource` to the same URL, as `matchResourceUrl` picks it, since that route also derives it from the request.
   */
  resourceUrl?: McpResourceUrl | undefined;
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
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one
   * for each origin the server answers on. Clerk rejects a token whose `aud` claim does not include the URL for the
   * request's origin, so a token issued for one listed URL does not pass on another, and a request to any other origin
   * gets a 421. The challenge's `resource_metadata` is derived from it. Set the protected resource metadata route's
   * `resource` to the same URL, as `matchResourceUrl` picks it, since that route derives it from the request.
   */
  resourceUrl: McpResourceUrl;
};

type BearerResult =
  | { ok: true; authInfo: AuthInfo & { resourceMetadataUrl: string } }
  | {
      ok: false;
      failure: McpAuthFailure;
      status: 401 | 403 | 421;
      challenge: string | undefined;
      error: string;
    };

/** Throws a `Clerk error:` message when the options cannot produce a valid challenge. */
export function assertMcpAuthOptions(caller: string, options: McpAuthOptions | undefined) {
  assertScopeTokens(caller, 'requiredScopes', options?.requiredScopes ?? []);
  assertScopeTokens(caller, 'challengeScopes', options?.challengeScopes ?? []);
  if (options?.resourceUrl !== undefined) assertResourceUrls(caller, options.resourceUrl);
}

// Each URL is checked once here, so a request only has to find the one with its origin.
function assertResourceUrls(caller: string, resourceUrl: unknown) {
  const urls: unknown = typeof resourceUrl === 'string' ? [resourceUrl] : resourceUrl;
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(`Clerk error: ${caller} resourceUrl must be a URL or a non-empty list of URLs`);
  }

  const origins = new Set<string>();
  for (const url of urls) {
    if (typeof url !== 'string' || !isResourceUrl(url)) {
      throw new Error(
        `Clerk error: ${caller} resourceUrl must be an absolute http or https URL without credentials or a fragment`,
      );
    }
    // The request's origin picks the URL, so two URLs with one origin would leave the choice ambiguous
    const { origin } = new URL(url);
    if (origins.has(origin)) {
      throw new Error(
        `Clerk error: ${caller} resourceUrl lists more than one URL for ${origin}. List one URL for each origin`,
      );
    }
    origins.add(origin);
  }
}

/**
 * The audience for a request that `mcpAuth` let through, which always matches a listed `resourceUrl`, since a request
 * to any other origin gets a 421 first.
 */
export function audienceFor(resourceUrl: McpResourceUrl, requestUrl: string): string {
  const audience = matchResourceUrl(resourceUrl, requestUrl);
  if (!audience) {
    throw new Error(
      `Clerk error: no resourceUrl matches the origin of ${new URL(requestUrl).origin}`,
    );
  }
  return audience;
}

// A URL with another scheme, such as `mailto:`, has no origin for the challenge, `new Request` throws on a URL with
// credentials, and a resource identifier must not have a fragment (RFC 8707 section 2).
function isResourceUrl(value: string): boolean {
  if (!URL.canParse(value) || value.includes('#')) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
}

/**
 * Throws a `Clerk error:` message unless `options` has a `resourceUrl`. Code written for the earlier `mcpAuthClerk`,
 * which was the middleware itself, passes it straight to a route, so the framework calls it with the request where
 * the options belong. Without this check that call would quietly return a middleware and the request would hang.
 */
export function assertMcpAuthClerkOptions(options: McpAuthClerkOptions) {
  if (typeof options?.resourceUrl !== 'string' && !Array.isArray(options?.resourceUrl)) {
    throw new Error(
      "Clerk error: mcpAuthClerk needs a resourceUrl. Call it as mcpAuthClerk({ resourceUrl: 'https://mcp.example.com/mcp' }) instead of passing mcpAuthClerk to the route directly",
    );
  }
  assertMcpAuthOptions('mcpAuthClerk', options);
}

/**
 * Throws a `Clerk error:` message unless `Transport` is a class. Code written before `streamableHttpHandler` took the
 * SDK transport as an argument calls it with the server factory alone, which would otherwise fail on every request
 * instead of at startup.
 */
export function assertTransportClass(Transport: unknown, className: string, sdkModule: string) {
  if (typeof Transport !== 'function') {
    throw new Error(
      `Clerk error: streamableHttpHandler needs the MCP SDK transport class as its second argument. Import ${className} from '@modelcontextprotocol/sdk/server/${sdkModule}' and call streamableHttpHandler(createServer, ${className})`,
    );
  }
}

/**
 * Throws a `Clerk error:` message unless `createServer` is a function. Code written when the Express adapter also
 * accepted a shared server object passes that object here; a shared server handles only one request at a time, so this
 * fails at startup instead of on concurrent requests.
 */
export function assertServerFactory(createServer: unknown, transportClassName: string) {
  if (typeof createServer !== 'function') {
    throw new Error(
      `Clerk error: streamableHttpHandler needs a function that returns a new MCP server as its first argument, so each request gets its own server. Call streamableHttpHandler(() => new McpServer(...), ${transportClassName}) instead of passing a server object`,
    );
  }
}

/**
 * The RFC 9728 section 3 metadata URL for a resource: the well-known path goes between the host and the resource's
 * path and query.
 */
export function resourceMetadataUrlFor(resourceUrl: string): string {
  const { origin, pathname, search } = new URL(resourceUrl);
  return `${origin}/.well-known/oauth-protected-resource${pathname === '/' ? '' : pathname}${search}`;
}

/**
 * The resource a protected resource metadata URL describes, the inverse of `resourceMetadataUrlFor`: the well-known
 * path is removed and the rest of the path and the query are kept as they are, so
 * `/.well-known/oauth-protected-resource/mcp/` describes `<origin>/mcp/` and the root describes the bare origin. RFC
 * 9728 section 3.3 has clients discard metadata whose `resource` is not identical to the URL they derived it from.
 */
export function resourceFromMetadataUrl(metadataUrl: string): string {
  const { origin, pathname, search } = new URL(metadataUrl);
  return `${origin}${pathname.replace('/.well-known/oauth-protected-resource', '')}${search}`;
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

// The token from a well-formed `Bearer <token>` header. The scheme is case-insensitive. Malformed Bearer credentials
// are challenged like a missing header, not answered with the 400 `invalid_request` that RFC 6750 section 3.1
// suggests, so that a client sending an empty token can still start authorization.
function parseAuthorization(header: string | undefined): ParsedAuthorization {
  if (!header?.trim()) return { reason: 'missing_token' };
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    return { reason: 'malformed_token' };
  }
  return { token };
}

// The RFC 9728 metadata URL for the request's own path, used when `resourceUrl` is not set. The request's query is
// left out: it belongs to the request, not to the resource.
function requestResourceMetadataUrl(requestUrl: string): string {
  const { origin, pathname } = new URL(requestUrl);
  return resourceMetadataUrlFor(`${origin}${pathname}`);
}

/**
 * Applies the response rule the adapters share. With a list of `resourceUrl`s, a request to an origin none of them has
 * gets a 421 without a challenge, before the token is read: no metadata URL there describes this server, and RFC 8707
 * section 3 audience-restricts a token so it cannot be presented to another resource. Otherwise the request uses the
 * listed URL with its origin. A missing or malformed header gets a challenge without an error code,
 * a rejected token adds `error="invalid_token"` (RFC 6750 section 3), and both 401 challenges list `requiredScopes`
 * then `challengeScopes` in `scope` (RFC 6750 section 3). A token without `requiredScopes` gets a 403 with
 * `error="insufficient_scope"` (RFC 6750 section 3.1). The 403 `scope` is the granted scopes followed by the missing
 * ones, as in `requireAdditionalScopes`, so the new grant keeps the old access. A verified token's auth info gets
 * `resourceMetadataUrl`, which MCP SDK 2 puts in the `resource_metadata` of its own scope challenges. A verifier that
 * throws an `McpTokenVerificationError` rejects the token, with that error as the failure's `cause`. Any other error
 * it throws gets wrapped in an `McpAuthError`.
 */
export async function authenticateBearer({
  authorization,
  requestUrl,
  resourceUrl,
  requiredScopes = [],
  challengeScopes: extraChallengeScopes = [],
  verifyToken,
}: {
  authorization: string | undefined;
  /** The URL the request was made to, used to pick a listed `resourceUrl`, or to derive one when it is not set. */
  requestUrl: string;
  resourceUrl: McpResourceUrl | undefined;
  requiredScopes: readonly string[] | undefined;
  challengeScopes: readonly string[] | undefined;
  verifyToken: (token: string) => Promise<AuthInfo | undefined>;
}): Promise<BearerResult> {
  let resourceMetadataUrl: string;
  if (resourceUrl === undefined) {
    resourceMetadataUrl = requestResourceMetadataUrl(requestUrl);
  } else {
    const matched = matchResourceUrl(resourceUrl, requestUrl);
    if (!matched) {
      return {
        ok: false,
        failure: { reason: 'misdirected_request' },
        status: 421,
        challenge: undefined,
        error: 'misdirected_request',
      };
    }
    resourceMetadataUrl = resourceMetadataUrlFor(matched);
  }

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
  let rejection: McpTokenVerificationError | undefined;
  try {
    authInfo = await verifyToken(parsed.token);
  } catch (error) {
    if (!(error instanceof McpTokenVerificationError)) {
      throw error instanceof McpAuthError ? error : new McpAuthError(error);
    }
    rejection = error;
  }

  // An expired token gets `invalid_token` (RFC 6750 section 3.1). Clerk rejects an expired token itself, but a
  // `verifyToken` passed to `mcpAuth` can return the auth info of a token it decoded or cached. An `expiresAt` that is
  // not a finite number, such as `NaN`, is not a time the token is valid until, so it is rejected too.
  if (
    authInfo?.expiresAt !== undefined &&
    !(Number.isFinite(authInfo.expiresAt) && authInfo.expiresAt > Date.now() / 1000)
  ) {
    rejection = new McpTokenVerificationError(
      'token-expired',
      Number.isFinite(authInfo.expiresAt)
        ? `The token expired at ${new Date(authInfo.expiresAt * 1000).toISOString()}`
        : `The token has no valid expiry time (${authInfo.expiresAt})`,
    );
    authInfo = undefined;
  }

  if (!authInfo) {
    return {
      ok: false,
      failure: { reason: 'invalid_token', ...(rejection && { cause: rejection }) },
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
 * Verifies an OAuth access token with Clerk, requiring `audience` in its `aud` claim. For a token Clerk rejects, this
 * throws an `McpTokenVerificationError` with the reason and message Clerk gave, so that the token reaches the client
 * as an `invalid_token` challenge. When Clerk could not verify an opaque token at all, this throws an `McpAuthError`
 * around that error instead and the framework answers with a server error: an `invalid_token` challenge would make
 * the client discard a valid token and restart authorization. Clerk does not report a JWKS failure on a JWT access
 * token separately from an invalid signature, so that case is still a rejection.
 */
export async function verifyClerkOAuthToken(
  client: ClerkOAuthClient,
  token: string,
  audience: string,
) {
  // Clerk compares the audience exactly, and a client can send the resource in normalized form, such as
  // `https://mcp.example.com/` for `https://mcp.example.com`, so both forms of the same URL are accepted. For the root
  // the bare origin is accepted too, because that is the `resource` the protected resource metadata describes for it.
  const url = new URL(audience);
  const forms = [audience, url.href];
  if (url.pathname === '/' && !url.search) forms.push(url.origin);
  const audiences = [...new Set(forms)];
  const requestState = await client.authenticateRequest(
    new Request(audience, { headers: { authorization: `Bearer ${token}` } }),
    {
      acceptsToken: 'oauth_token',
      audience: audiences.length === 1 ? audience : audiences,
    },
  );
  if (!requestState.isAuthenticated) {
    const { reason, message } = requestState;
    // Clerk leaves the message empty for some reasons, such as `token-type-mismatch`
    const error = new McpTokenVerificationError(
      reason,
      message || `Clerk did not accept the token (${reason})`,
    );
    if (verificationUnavailable.has(reason)) throw new McpAuthError(error);
    throw error;
  }

  const authInfo = toClerkAuthInfo(requestState.toAuth(), token);
  if (!authInfo) {
    throw new McpTokenVerificationError(
      'token-claims-missing',
      'Clerk verified the token, but it has no user ID, client ID, or scopes',
    );
  }
  return authInfo;
}
