import type { AuthInfo } from './mcp-types';
import { hasClerkVerification, markClerkVerified } from './clerk-auth-info';
import { deriveFapiUrl } from './publishable-key';
import { assertPropertiesOmitResource } from './resource-metadata-properties';

/**
 * The fields `toClerkAuthInfo` reads from Clerk's auth object for an OAuth access token, the result of
 * a request state's `toAuth()` after `authenticateRequest(req, { acceptsToken: 'oauth_token', audience: resourceUrl })`.
 * Declared here so that this package's
 * types do not need `@clerk/backend`, which an app using `@clerk/express`, `@clerk/hono`, or `@clerk/nextjs` may not
 * list itself. Not exported: Clerk's own auth object satisfies it structurally.
 */
type ClerkOAuthAuthObject = {
  isAuthenticated: boolean;
  tokenType: string | null;
  id?: string | null | undefined;
  subject?: string | null | undefined;
  userId?: string | null | undefined;
  clientId?: string | null | undefined;
  scopes?: string[] | null | undefined;
  getToken?: (() => Promise<string | null>) | undefined;
};

/**
 * The part of a Clerk client, such as one from `createClerkClient`, that `mcpAuth` and `withClerkMcpAuth` use to verify OAuth access
 * tokens. Declared here so that this package's types do not need `@clerk/backend`. Create the client with both
 * `secretKey` and `publishableKey`, from `@clerk/backend` 3.19.0 or later, the first with a reliable audience check.
 */
export type ClerkOAuthClient = {
  authenticateRequest(
    request: Request,
    options: { acceptsToken: 'oauth_token'; audience: string | string[] },
  ): Promise<
    | { isAuthenticated: true; toAuth(): ClerkOAuthAuthObject }
    | { isAuthenticated: false; reason: string; message: string }
  >;
};

/**
 * Why `mcpAuth` answered a request with a 401 or 403 challenge, or with a 421 for a request to an origin that no
 * listed `resourceUrl` has. The Express and Hono adapters record it on the request context, as
 * `res.locals.mcpAuthFailure` and `c.get('mcpAuthFailure')`, and the Next.js adapter passes it to `onAuthFailure`, for
 * example for logging.
 */
export type McpAuthFailure = {
  reason:
    | 'missing_token'
    | 'malformed_token'
    | 'invalid_token'
    | 'insufficient_scope'
    | 'misdirected_request';
  /**
   * What the verifier reported for the token behind an `invalid_token`, when it reported anything. Clerk verification
   * sets it for a token Clerk rejected.
   */
  cause?: McpTokenVerificationError | undefined;
};

/**
 * What a verifier reported for a token it did not accept. Clerk verification creates one from the `reason` and `message`
 * of Clerk's request state. It is the `cause` of an `invalid_token` failure when Clerk rejected the token, and the
 * `cause` of the `McpAuthError` when Clerk answered but could not verify the token. A verifier passed to `mcpAuth`
 * as `verifyToken` can throw one to reject a token with a code of its own. It is never sent to the client.
 */
export class McpTokenVerificationError extends Error {
  /**
   * A machine-readable code for the failure. From Clerk verification it is the `reason` of Clerk's request state, such as
   * `token-invalid` or `token-verification-failed`. Clerk gives every failed check on a JWT access token
   * `token-verification-failed`, so the `message` is what says which check failed.
   */
  readonly code: string;
  /**
   * The HTTP status the verifier's upstream answered with, when it reported one. From Clerk verification it is the
   * status of Clerk's Backend API response, such as `503`. An `McpAuthError` around this error answers with it when it
   * is a 429 or a 5xx.
   */
  readonly status: number | undefined;

  constructor(code: string, message: string, options?: { status?: number | undefined }) {
    super(message);
    this.name = 'McpTokenVerificationError';
    this.code = code;
    this.status = options?.status;
  }
}

/**
 * Wraps errors from the shared verifier when the token could not be verified at all, such as when the verifier
 * throws or Clerk is unreachable. The adapters catch and log this error, then return a JSON server error with the
 * cause's eligible 429 or 5xx status, or 500, instead of a challenge that would make the client discard a valid token.
 * The verifier's error is the `cause`: an `McpTokenVerificationError` when Clerk answered but could not verify the
 * token. Setup errors remain separate and escape to the framework's error handler.
 */
export class McpAuthError extends Error {
  readonly reason = 'verification_failed';
  /**
   * The `cause`'s `status` when it is a 429 or a 5xx, the status the adapters answer with, so a client can tell rate
   * limiting (RFC 6585 section 4) from an outage. Any other status would become the answer to the client's own
   * request, such as a 401 without the challenge a 401 must carry (RFC 9110 section 15.5.2). A status must be an
   * integer, a three-digit code (RFC 9110 section 15): Express's `res.status()` throws on any other number, which would
   * lose the JSON answer.
   */
  readonly status: number | undefined;

  constructor(cause: unknown) {
    // No `Clerk error:` prefix, which marks setup mistakes: the verifier can be the app's own `verifyToken`, and the
    // `cause` says what failed
    super('MCP access token verification failed', { cause });
    this.name = 'McpAuthError';
    const status = (cause as { status?: unknown } | null)?.status;
    this.status =
      typeof status === 'number' &&
      Number.isInteger(status) &&
      (status === 429 || (status >= 500 && status <= 599))
        ? status
        : undefined;
  }
}

/**
 * A protocol method that a `publicAccess.methods` list can open to requests without a token, each of which
 * `discoverable` opens by default. `initialize` is the handshake of the protocol revisions before 2026-07-28 and covers its
 * `notifications/initialized` notification, and `server/discover` replaces it from 2026-07-28. The methods that run something, `tools/call`, `resources/read`, and
 * `prompts/get`, are not in this list: `publicAccess.tools`, `resources`, and `prompts` open those.
 */
export type McpPublicMethod =
  | 'initialize'
  | 'server/discover'
  | 'ping'
  | 'tools/list'
  | 'resources/list'
  | 'resources/templates/list'
  | 'prompts/list';

/**
 * What a request without an `Authorization` header may do besides what `discoverable` opens, as the `publicAccess`
 * option of `mcpAuth` and `withClerkMcpAuth`. A call is open only when it is listed here, or is the read of a `ui://` view that `views` opens, and a request for anything
 * else gets the 401 challenge that starts authorization, so an MCP client signs in only when it reaches something
 * protected. A request that carries a token is verified as usual, whatever it asks for.
 */
export type PublicAccess = {
  /**
   * Advanced: exactly the protocol methods open without a token, as a list of `McpPublicMethod`s, in place of the
   * ones `discoverable` opens. Leave it out to use `discoverable`, which cannot be set next to it. A client connects
   * with `initialize` before protocol revision 2026-07-28 and with `server/discover` from it, so a list that names
   * one and not the other leaves some clients unable to connect, and `tools`, `resources`, and `prompts` need the
   * list to name at least one. An open list method shows its whole list, so with `tools/list` open anyone can read
   * the name, description, and input schema of every tool, the protected ones included. It never opens a call, but a
   * list that opens `resources/list` and either handshake turns `views` on by default, as `discoverable` does. With
   * `initialize` or `server/discover` open, a GET without a token gets a 405 rather than the 401, and a
   * `subscriptions/listen` (protocol revision 2026-07-28) is open when every resource in its `resourceSubscriptions`
   * is one `resources` opens.
   */
  methods?: readonly McpPublicMethod[] | undefined;
  /**
   * The tools a `tools/call` may name without a token. Each one is listed by name: no value opens every tool.
   * Keep `create_browser_session` out: it requires a Clerk identity, and its `not_authenticated` error will not start
   * sign-in. The auth entry points log a one-time `Clerk warning:` at startup when it is listed.
   */
  tools?: readonly string[] | undefined;
  /**
   * The resources a `resources/read` may ask for without a token: `true` for every resource, or a list of resource
   * URIs. A URI is compared exactly as the client sends it, so a list cannot open the URIs of a resource template.
   */
  resources?: boolean | readonly string[] | undefined;
  /**
   * The prompts a `prompts/get` may ask for without a token: `true` for every prompt, or a list of prompt names.
   */
  prompts?: boolean | readonly string[] | undefined;
  /**
   * Whether a `resources/read` without a token may ask for an MCP App view template, any URI with the `ui://`
   * scheme. On by default when the server is discoverable: `discoverable` left out or `true`, or a `methods` list
   * that opens `resources/list` and `initialize` or `server/discover`, so a client without a token can connect. MCP Apps (2026-01-26) lets a host prefetch and cache a view before any tool runs, so
   * before the user has signed in, and a scanner reads it to check the view. A view template is shared HTML: user data
   * reaches it only through the result of an authenticated tool call. Set `views: false` when your server renders
   * per-user data into a template, so every view needs a token; `resources` can still open single views by URI.
   */
  views?: boolean | undefined;
};

/**
 * Input to `generateProtectedResourceMetadata`: a Clerk publishable key, or the issuer identifier of any other
 * authorization server, never both.
 */
type GenerateProtectedResourceMetadataOptions = {
  /**
   * Resource identifier of the protected resource
   */
  resourceUrl: string;
  /**
   * Additional properties to include in the metadata. They override the generated ones, except `resource`, which
   * they cannot set: it is always `resourceUrl` (RFC 9728 section 3.3).
   */
  properties?: Record<string, unknown>;
} & (
  | {
      /**
       * Clerk publishable key. The authorization server is the instance's Frontend API.
       */
      publishableKey: string;
      authServerUrl?: never;
    }
  | {
      /**
       * Issuer identifier of the authorization server
       */
      authServerUrl: string;
      publishableKey?: never;
    }
);

/**
 * Generates RFC 9728 protected resource metadata for the given resource url and either a Clerk publishable key or
 * the issuer identifier of another authorization server. It holds only parameters RFC 9728 section 2 defines:
 * `resource`, `authorization_servers`, and `bearer_methods_supported`, since the adapters read the token from the
 * `Authorization` header alone. Pass others, such as `resource_name` or `resource_documentation`, in `properties`.
 * `resource` is always `resourceUrl`, since a client discards metadata whose `resource` is not the URL it derived the
 * metadata URL from (RFC 9728 section 3.3): it throws a `Clerk error:` when `properties` has its own `resource` key,
 * even one set to `undefined`, as the `protectedResourceMetadataHandler`s do.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-2
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3.3
 * @param options - `{ resourceUrl, publishableKey }` for Clerk, or `{ resourceUrl, authServerUrl }` for any other
 * authorization server, each with optional `properties`
 * @returns Protected resource metadata, serializable to JSON
 */
export function generateProtectedResourceMetadata(
  options: GenerateProtectedResourceMetadataOptions,
) {
  assertPropertiesOmitResource('generateProtectedResourceMetadata', options.properties);
  const authServerUrl =
    options.publishableKey === undefined
      ? options.authServerUrl
      : deriveFapiUrl(options.publishableKey);
  return Object.assign(
    {
      resource: options.resourceUrl,
      authorization_servers: [authServerUrl],
      bearer_methods_supported: ['header'],
    },
    options.properties,
  );
}

// How long `fetchAuthorizationServerMetadata` waits for the Frontend API, headers and body together
const AUTHORIZATION_SERVER_METADATA_TIMEOUT_MS = 5_000;

/**
 * Fetches RFC 8414 authorization server metadata for the Clerk instance a publishable key belongs to, from its
 * Frontend API's `/.well-known/oauth-authorization-server`.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8414#section-3
 * @param publishableKey - Clerk publishable key
 * @returns The parsed metadata document. It throws a `Clerk error:` when the publishable key is not one, when the
 * Frontend API does not answer with a 2xx, so an error body is never served, or cached, as the metadata, and when it
 * has not answered within 5 seconds.
 */
export async function fetchAuthorizationServerMetadata({
  publishableKey,
}: {
  publishableKey: string;
}) {
  const fapiUrl = deriveFapiUrl(publishableKey);

  try {
    // Bounded so that a Frontend API that accepts the connection but never answers gets the handler's 502 well before
    // a serverless platform's own timeout, instead of holding the request for the runtime's default of minutes
    const res = await fetch(`${fapiUrl}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(AUTHORIZATION_SERVER_METADATA_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `Clerk error: fetching authorization server metadata from ${fapiUrl} failed with status ${res.status}`,
      );
    }
    return await res.json();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
    throw new Error(
      `Clerk error: fetching authorization server metadata from ${fapiUrl} timed out after ${AUTHORIZATION_SERVER_METADATA_TIMEOUT_MS / 1000} seconds`,
      { cause: error },
    );
  }
}

/**
 * Converts Clerk's auth object for an already-verified OAuth access token into the `AuthInfo` the MCP SDK expects.
 * It verifies nothing itself: pass `requestState.toAuth()` only from
 * `authenticateRequest(req, { acceptsToken: 'oauth_token', audience: resourceUrl })`, which checks this resource's
 * audience (RFC 9068 section 4; RFC 7519 section 4.1.3). `auth({ acceptsToken: 'oauth_token' })` alone is not sufficient.
 * Prefer `mcpAuth({ clerkClient, resourceUrl })` or `withClerkMcpAuth(handler, { clerkClient, resourceUrl })` instead.
 * @param auth - The auth object from the audience-checked request state's `toAuth()`
 * @param token - The access token the auth object was produced from
 * @returns A `ClerkAuthInfo`, which is an `AuthInfo` (the MCP SDK auth info type), or `undefined`
 */
export function toClerkAuthInfo(
  auth: ClerkOAuthAuthObject,
  token: string | undefined,
): ClerkAuthInfo | undefined {
  if (!token) return undefined;

  // An unauthenticated auth object is an ordinary outcome, such as a client without a valid token, not an error to log
  if (!auth.isAuthenticated) return undefined;

  if (auth.tokenType !== 'oauth_token') {
    throw new Error("the auth() function must be called with acceptsToken: 'oauth_token'");
  }

  // None of these _should_ ever happen
  if (!auth.clientId) {
    console.error('Clerk error: No clientId returned from auth()');
    return undefined;
  }

  if (!auth.scopes) {
    console.error('Clerk error: No scopes returned from auth()');
    return undefined;
  }

  if (!auth.userId) {
    console.error('Clerk error: No userId returned from auth()');
    return undefined;
  }

  // Clerk sets `id` to an empty string for a JWT access token without a `jti`, so only the type is checked
  if (
    typeof auth.id !== 'string' ||
    typeof auth.subject !== 'string' ||
    typeof auth.getToken !== 'function'
  ) {
    console.error('Clerk error: No id, subject, or getToken returned from auth()');
    return undefined;
  }

  return markClerkVerified<ClerkAuthInfo>({
    token,
    scopes: auth.scopes,
    clientId: auth.clientId,
    // The checks above guarantee every `ClerkOAuthAuth` field; `getToken` is `() => Promise<string>` for an
    // authenticated `oauth_token` auth object.
    extra: { userId: auth.userId, verifiedBy: 'clerk', auth: auth as ClerkOAuthAuth },
  });
}

/**
 * Clerk's auth object for a verified OAuth access token, as `toClerkAuthInfo` stores it on `extra.auth`. At runtime it
 * is the object Clerk returned. Declared here so that this package's types do not need `@clerk/backend`. Clerk's `has()`
 * and `debug` are left out: for an OAuth token, `has()` always returns `false`, so check `scopes` instead.
 */
export type ClerkOAuthAuth = {
  isAuthenticated: true;
  tokenType: 'oauth_token';
  /**
   * The token's id. Empty for a JWT access token without a `jti` claim.
   */
  id: string;
  /**
   * The token's subject, the signed-in user.
   */
  subject: string;
  userId: string;
  clientId: string;
  scopes: string[];
  /**
   * Resolves to the access token.
   */
  getToken: () => Promise<string>;
};

/**
 * Auth info produced by `toClerkAuthInfo`. `extra.auth` is Clerk's auth object for the token. `clientId` can be empty,
 * and `extra.auth` missing, when the `AuthInfo` was built by hand.
 */
export type ClerkAuthInfo = AuthInfo & {
  extra: { userId: string; verifiedBy: 'clerk'; auth?: ClerkOAuthAuth | undefined };
};

/**
 * Whether `authInfo` came from `toClerkAuthInfo` or the bearer authenticator's metadata copy of it, so its `clientId`
 * and `extra.userId` are Clerk ids. Private object provenance is required: a hand-built or externally copied object
 * with `extra.verifiedBy: 'clerk'` is not trusted. This does not verify a token; `toClerkAuthInfo` takes an already
 * verified and audience-checked Clerk auth object.
 */
export function isClerkAuthInfo(authInfo: AuthInfo | undefined): authInfo is ClerkAuthInfo {
  if (!authInfo || !hasClerkVerification(authInfo)) return false;
  const userId = authInfo.extra?.userId;
  return authInfo.extra?.verifiedBy === 'clerk' && typeof userId === 'string' && userId !== '';
}

export { requireAdditionalScopes } from './scope-challenge';

export { type McpResourceUrl, matchResourceUrl } from './resource-url';

export {
  type ServerCard,
  type ServerCardIcon,
  type ServerCardOptions,
  type ServerCardRepository,
  generateServerCard,
} from './server-card';
export {
  type RegistryServerJson,
  type RegistryServerJsonOptions,
  generateRegistryServerJson,
} from './mcp-registry';
export {
  type AICatalog,
  type AICatalogAttestation,
  type AICatalogEntry,
  type AICatalogEntryOptions,
  type AICatalogHost,
  type AICatalogOptions,
  type AICatalogTrustManifest,
  ardLinkHeader,
  generateAICatalog,
} from './ai-catalog';

/**
 * CORS headers for OAuth metadata endpoints
 */
export const metadataCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};
