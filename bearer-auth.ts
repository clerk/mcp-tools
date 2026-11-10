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
  generateProtectedResourceMetadata,
  matchResourceUrl,
  toClerkAuthInfo,
} from './server';

/**
 * The options every auth entry point takes, with `resourceUrl` optional as it is for a custom verifier.
 */
export type BaseAuthOptions = {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one
   * for each origin the server answers on. A request uses the listed URL with its origin, and a request to any other
   * origin gets a 421. The request's origin is the one the app sees, so behind a proxy that terminates TLS or rewrites
   * `Host`, list those URLs or, in Express, set `trust proxy`. The challenge's `resource_metadata` is derived from it.
   * With `verifyToken` it can be omitted, and it is then derived from the incoming request, which can differ from the
   * public URL behind a proxy. Without `verifyToken` it is required: Clerk rejects a token whose `aud` claim does not
   * include the URL for the request's origin, so a token issued for one listed URL does not pass on another. Pass the
   * same value to `protectedResourceMetadataHandler`, so its `resource` is the URL checked here.
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
 * The options for verifying tokens with Clerk, which needs `resourceUrl` as the audience.
 */
export type ClerkAuthOptions = BaseAuthOptions & {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one
   * for each origin the server answers on. Clerk rejects a token whose `aud` claim does not include the URL for the
   * request's origin, so a token issued for one listed URL does not pass on another, and a request to any other origin
   * gets a 421. The challenge's `resource_metadata` is derived from it. Pass the same value to
   * `protectedResourceMetadataHandler`, so its `resource` is the URL checked here.
   */
  resourceUrl: McpResourceUrl;
};

/**
 * The branch of every adapter's options union that verifies tokens with the caller's function, for the framework's
 * request type `Req`. `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type CustomVerifierAuthOptions<Req> = BaseAuthOptions & {
  /**
   * Verifies a token in place of Clerk and returns its auth info, or `undefined` to reject it. Throw an
   * `McpTokenVerificationError` to reject it with a reason. The token comes first and the request second, the reverse
   * of the verifier `withMcpAuth` from `mcp-handler` takes.
   * @param token - The bearer token from the request
   * @param request - The framework's request or context
   * @returns The token's auth info, or `undefined` to reject it, or a promise of either
   */
  verifyToken: (
    token: string,
    request: Req,
  ) => AuthInfo | undefined | Promise<AuthInfo | undefined>;
  clerkClient?: never;
};

/**
 * The options of the Express and Hono `mcpAuth` middleware, for the framework's request type `Req`. Without
 * `verifyToken`, Clerk verifies each token, and `resourceUrl` is required as its audience. With `verifyToken`, that
 * function verifies each token instead, `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type MiddlewareAuthOptions<Req> =
  | (ClerkAuthOptions & {
      /**
       * The Clerk client that verifies tokens. Create it with both `secretKey` and `publishableKey`: without a
       * publishable key, every request fails. A client from `@clerk/backend` must be version 3.19.0 or later, the
       * first with a reliable audience check.
       */
      clerkClient?: ClerkOAuthClient | undefined;
      verifyToken?: never;
    })
  | CustomVerifierAuthOptions<Req>;

/**
 * The options of every adapter's `protectedResourceMetadataHandler`.
 */
export type ProtectedResourceMetadataOptions = {
  /**
   * The `resourceUrl` given to `mcpAuth` or `withMcpAuth` for the endpoint this metadata describes: one URL, or a list
   * with one for each origin. The metadata's `resource` is then the URL they check for the same request, whatever
   * origin the app sees behind a proxy for a single URL, and with a list a request to an origin none of them has gets
   * a 421. Without it, `resource` is derived from the URL the metadata route was requested at, which can differ from
   * the public URL behind a proxy.
   */
  resourceUrl?: McpResourceUrl | undefined;
  /**
   * Additional metadata, such as `resource_name` or `scopes_supported`. It overrides the generated metadata.
   */
  properties?: Record<string, unknown> | undefined;
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

/**
 * Throws a `Clerk error:` message when the options cannot produce a valid challenge: a `requiredScopes` or
 * `challengeScopes` entry that is not an RFC 6749 section 3.3 scope-token, or a `resourceUrl` that is not one absolute http or https
 * URL per origin, without credentials or a fragment.
 * @param caller - The entry point named in the message, such as `mcpAuth`
 * @param options - The entry point's options
 */
export function assertMcpAuthOptions(caller: string, options: BaseAuthOptions | undefined) {
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
 * Throws a `Clerk error:` message unless `options` is `undefined` or an object with only `resourceUrl` and
 * `properties`, then checks `resourceUrl` as `mcpAuth` does. The handler took the additional metadata itself before it
 * took options, so code written for that form, such as `protectedResourceMetadataHandler({ scopes_supported })`, fails
 * at startup with a message naming the new form instead of serving metadata without it.
 */
export function assertProtectedResourceMetadataOptions(options: unknown) {
  if (options === undefined) return;
  const isOptions =
    typeof options === 'object' &&
    options !== null &&
    !Array.isArray(options) &&
    Object.keys(options).every((key) => key === 'resourceUrl' || key === 'properties');
  if (!isOptions) {
    throw new Error(
      "Clerk error: protectedResourceMetadataHandler takes an options object with resourceUrl and properties. Pass the resourceUrl you give mcpAuth or withMcpAuth, and any other metadata in properties, as protectedResourceMetadataHandler({ resourceUrl: 'https://mcp.example.com/mcp', properties: { scopes_supported: ['email'] } })",
    );
  }
  assertMcpAuthOptions('protectedResourceMetadataHandler', options);
}

/**
 * The protected resource metadata a Clerk instance's `protectedResourceMetadataHandler` serves for a request, or
 * `undefined` when a list of `resourceUrl`s has none with the request's origin, which the adapters answer with a 421,
 * as `mcpAuth` does (RFC 9110 section 15.5.20). The `resource` is the `resourceUrl` for the request, the URL `mcpAuth`
 * checks, or without `resourceUrl` the resource the requested metadata URL describes, so it is identical to the URL
 * the client derived the metadata URL from (RFC 9728 section 3.3).
 * @param options - The handler's options, already checked
 * @param metadataUrl - The URL the metadata route was requested at
 * @param publishableKey - The Clerk publishable key
 * @returns The metadata, or `undefined` for a request to an origin no `resourceUrl` lists
 */
export function clerkProtectedResourceMetadata(
  { resourceUrl, properties }: ProtectedResourceMetadataOptions,
  metadataUrl: string,
  publishableKey: string,
) {
  const resource =
    resourceUrl === undefined
      ? resourceFromMetadataUrl(metadataUrl)
      : matchResourceUrl(resourceUrl, metadataUrl);
  if (resource === undefined) return undefined;
  return generateProtectedResourceMetadata({ publishableKey, resourceUrl: resource, properties });
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
 * Throws a `Clerk error:` message unless `options` is an options object that can verify tokens, then checks it as
 * `assertMcpAuthOptions` does. `mcpAuth` took a verifier function first before it took options alone, so code written
 * for that form fails at startup with a message naming the new form. Code that passes
 * `mcpAuth` straight to a route has the framework call it with the request where the options belong, which has no
 * `resourceUrl`, so that fails on the first request instead of hanging.
 */
export function assertMiddlewareAuthOptions(options: unknown) {
  if (typeof options === 'function') {
    throw new Error(
      `Clerk error: mcpAuth takes an options object, not a verifier function. Call it as mcpAuth({ verifyToken }) to verify tokens with your own function, or as mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp' }) to verify them with Clerk`,
    );
  }
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: mcpAuth needs a resourceUrl to verify tokens with Clerk. Call it as mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp' }), or as mcpAuth({ verifyToken }) with your own verifier, instead of passing mcpAuth to the route directly`,
  );
  assertMcpAuthOptions('mcpAuth', options as BaseAuthOptions);
}

/**
 * Throws `message` unless `options` has either a `verifyToken` or a `resourceUrl`, the audience Clerk verifies tokens
 * against. Each entry point names its own call forms in `message`.
 * @param options - The entry point's options, unchecked
 * @param message - The error message, starting with `Clerk error:`
 */
export function assertVerifierOrResourceUrl(options: unknown, message: string) {
  const { verifyToken, resourceUrl } = (options ?? {}) as {
    verifyToken?: unknown;
    resourceUrl?: unknown;
  };
  if (verifyToken === undefined && typeof resourceUrl !== 'string' && !Array.isArray(resourceUrl)) {
    throw new Error(message);
  }
}

/**
 * The verifier for the Clerk branch of an entry point's options. Each token is verified with the client `clientFor`
 * returns for the request, with the listed `resourceUrl` for the request's origin as the audience.
 * @param options - The Clerk branch of the options, which always has `resourceUrl`
 * @param clientFor - Returns the Clerk client for a request
 * @param requestUrlOf - Returns the URL a request was made to
 * @returns A verifier that takes the token and the framework's request
 */
export function clerkTokenVerifier<Req>(
  { resourceUrl }: ClerkAuthOptions,
  clientFor: (request: Req) => ClerkOAuthClient | Promise<ClerkOAuthClient>,
  requestUrlOf: (request: Req) => string,
): (token: string, request: Req) => Promise<AuthInfo> {
  return async (token, request) => {
    const client = await clientFor(request);
    return verifyClerkOAuthToken(client, token, audienceFor(resourceUrl, requestUrlOf(request)));
  };
}

/**
 * The publishable key the metadata handlers read from the app's environment, or an error when it is not set. The
 * adapters read the variable themselves: Next.js only inlines `process.env.NEXT_PUBLIC_*` where it is written out.
 * @param publishableKey - The value of the variable in the app's environment
 * @param name - The variable's name, for the error: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in Next.js
 * @returns The publishable key
 */
export function requirePublishableKey(
  publishableKey: string | undefined,
  name = 'CLERK_PUBLISHABLE_KEY',
): string {
  if (!publishableKey) {
    throw new Error(`${name} environment variable is required`);
  }
  return publishableKey;
}

/**
 * Throws a `Clerk error:` message when `authorizationServerMetadataHandler` received arguments. It takes none, so any
 * means it was passed to a route without being called, as 0.9.0's `authServerMetadataHandlerClerk` was, and the
 * framework called it with the request: that would otherwise hang the request in Express and Hono, and get a generic
 * error in Next.js.
 * @param argumentCount - The number of arguments the handler factory received
 */
export function assertAuthorizationServerMetadataHandlerCalled(argumentCount: number) {
  if (argumentCount > 0) {
    throw new Error(
      'Clerk error: call authorizationServerMetadataHandler() and pass its result to the route, instead of passing authorizationServerMetadataHandler itself',
    );
  }
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
  /**
   * The URL the request was made to, used to pick a listed `resourceUrl`, or to derive one when it is not set.
   */
  requestUrl: string;
  resourceUrl: McpResourceUrl | undefined;
  requiredScopes: readonly string[] | undefined;
  challengeScopes: readonly string[] | undefined;
  verifyToken: (token: string) => AuthInfo | undefined | Promise<AuthInfo | undefined>;
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
