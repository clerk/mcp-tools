import type { AuthInfo } from './mcp-types';

/**
 * The fields `toClerkAuthInfo` reads from Clerk's auth object for an OAuth access token, the result of
 * `auth({ acceptsToken: 'oauth_token' })` or of a request state's `toAuth()`. Declared here so that this package's
 * types do not need `@clerk/backend`, which an app using `@clerk/express`, `@clerk/hono`, or `@clerk/nextjs` may not
 * list itself. Not exported: Clerk's own auth object satisfies it structurally.
 */
type ClerkOAuthAuthObject = {
  isAuthenticated: boolean;
  tokenType: string | null;
  userId?: string | null | undefined;
  clientId?: string | null | undefined;
  scopes?: string[] | null | undefined;
};

/**
 * The part of a Clerk client, such as one from `createClerkClient`, that `mcpAuth` and `withMcpAuth` use to verify OAuth access
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

  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpTokenVerificationError';
    this.code = code;
  }
}

/**
 * Thrown by `mcpAuth` and `withMcpAuth` when the token could not be verified at all, such as when the verifier
 * throws or Clerk is unreachable, so the request reaches the framework's error handler instead of a challenge that
 * would make the client discard a valid token. The verifier's error is the `cause`: an `McpTokenVerificationError`
 * when Clerk answered but could not verify the token.
 */
export class McpAuthError extends Error {
  readonly reason = 'verification_failed';
  /**
   * The `cause`'s `status` when it is a 5xx, so Express's default error handler still answers with it. Any other
   * status would become the answer to the client's own request, such as a 401 without the challenge a 401 must carry
   * (RFC 9110 section 15.5.2).
   */
  readonly status: number | undefined;

  constructor(cause: unknown) {
    super('Clerk error: MCP access token verification failed', { cause });
    this.name = 'McpAuthError';
    const status = (cause as { status?: unknown } | null)?.status;
    this.status = typeof status === 'number' && status >= 500 && status <= 599 ? status : undefined;
  }
}

/**
 * The exact URL clients use for an MCP endpoint, or a list of them, one for each origin, for a server that answers on
 * several hostnames. With a list, a request uses the URL with its own origin, and a request to any other origin gets a
 * 421 Misdirected Request (RFC 9110 section 15.5.20).
 */
export type McpResourceUrl = string | readonly string[];

/**
 * A protocol method that `publicAccess.methods` can open to requests without a token. `initialize` is the handshake
 * of the protocol revisions before 2026-07-28 and covers its `notifications/initialized` notification, and
 * `server/discover` replaces it from 2026-07-28. The methods that run something, `tools/call`, `resources/read`, and
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
 * What a request without an `Authorization` header may do, as the `publicAccess` option of `mcpAuth` and
 * `withMcpAuth`. Nothing is open unless it is listed here, and a request for anything else gets the 401 challenge that
 * starts authorization, so an MCP client signs in only when it reaches something protected. A request that carries a
 * token is verified as usual, whatever it asks for.
 */
export type PublicAccess = {
  /**
   * The protocol methods open without a token: `true` for every `McpPublicMethod`, or a list of them. An open list
   * method shows its whole list, so with `tools/list` open anyone can read the name, description, and input schema of
   * every tool, the protected ones included. It never opens a call.
   */
  methods?: boolean | readonly McpPublicMethod[] | undefined;
  /**
   * The tools a `tools/call` may name without a token. Each one is listed by name: no value opens every tool.
   */
  tools?: readonly string[] | undefined;
  /**
   * Whether `resources/read` is open without a token, for every resource.
   */
  resources?: boolean | undefined;
  /**
   * Whether `prompts/get` is open without a token, for every prompt.
   */
  prompts?: boolean | undefined;
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
   * Additional properties to include in the metadata. They override the generated ones.
   */
  properties?: Record<string, unknown>;
} & (
  | {
      /**
       * Clerk publishable key. The authorization server is the instance's Frontend API, and Clerk's documentation is
       * added as `resource_documentation`.
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
 * `Authorization` header alone, plus `resource_documentation` pointing at Clerk's documentation when given a
 * publishable key. Pass others, such as `resource_name`, in `properties`.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-2
 * @param options - `{ resourceUrl, publishableKey }` for Clerk, or `{ resourceUrl, authServerUrl }` for any other
 * authorization server, each with optional `properties`
 * @returns Protected resource metadata, serializable to JSON
 */
export function generateProtectedResourceMetadata(
  options: GenerateProtectedResourceMetadataOptions,
) {
  const metadata = (authServerUrl: string) => ({
    resource: options.resourceUrl,
    authorization_servers: [authServerUrl],
    bearer_methods_supported: ['header'],
  });

  if (options.publishableKey === undefined) {
    return Object.assign(metadata(options.authServerUrl), options.properties);
  }

  return Object.assign(
    metadata(deriveFapiUrl(options.publishableKey)),
    { resource_documentation: 'https://clerk.com/docs' },
    options.properties,
  );
}

function deriveFapiUrl(publishableKey: string) {
  const key = publishableKey.replace(/^pk_(test|live)_/, '');
  const normalizedKey = key.replace(/-/g, '+').replace(/_/g, '/');
  const paddedKey = normalizedKey.padEnd(Math.ceil(normalizedKey.length / 4) * 4, '=');
  const decoded = atob(paddedKey);
  return `https://${decoded.replace(/\$/, '')}`;
}

/**
 * Fetches RFC 8414 authorization server metadata for the Clerk instance a publishable key belongs to, from its
 * Frontend API's `/.well-known/oauth-authorization-server`.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8414#section-3
 * @param publishableKey - Clerk publishable key
 * @returns The parsed metadata document. It throws a `Clerk error:` when the Frontend API does not answer with a 2xx,
 * so an error body is never served, or cached, as the metadata.
 */
export async function fetchAuthorizationServerMetadata({
  publishableKey,
}: {
  publishableKey: string;
}) {
  const fapiUrl = deriveFapiUrl(publishableKey);

  const res = await fetch(`${fapiUrl}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(
      `Clerk error: fetching authorization server metadata from ${fapiUrl} failed with status ${res.status}`,
    );
  }
  return res.json();
}

/**
 * Converts Clerk's auth object for an already-verified OAuth access token into the `AuthInfo` the MCP SDK expects.
 * It verifies nothing itself: pass the result of `auth({ acceptsToken: 'oauth_token' })` or of a request state's
 * `toAuth()`, which Clerk has already checked.
 * @param auth - The auth object returned from the Clerk auth() function called with acceptsToken: 'oauth_token'
 * @param token - The access token the auth object was produced from
 * @returns A `ClerkAuthInfo`, which is an `AuthInfo` (the MCP SDK auth info type), or `undefined`
 */
export function toClerkAuthInfo(
  auth: ClerkOAuthAuthObject,
  token: string | undefined,
): ClerkAuthInfo | undefined {
  if (!token) return undefined;

  if (!auth.isAuthenticated) {
    console.error('Invalid OAuth access token');
    return undefined;
  }

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

  return {
    token,
    scopes: auth.scopes,
    clientId: auth.clientId,
    extra: { userId: auth.userId, verifiedBy: 'clerk' },
  };
}

/**
 * Auth info produced by `toClerkAuthInfo`. `clientId` can be empty when the `AuthInfo` was built by hand.
 */
export type ClerkAuthInfo = AuthInfo & { extra: { userId: string; verifiedBy: 'clerk' } };

/**
 * Whether `authInfo` came from `toClerkAuthInfo`, so its `clientId` and `extra.userId` are Clerk ids.
 */
export function isClerkAuthInfo(authInfo: AuthInfo | undefined): authInfo is ClerkAuthInfo {
  const userId = authInfo?.extra?.userId;
  return authInfo?.extra?.verifiedBy === 'clerk' && typeof userId === 'string' && userId !== '';
}

export { requireAdditionalScopes } from './scope-challenge';

/**
 * The URL from `resourceUrl` that a request to `requestUrl` is for: `resourceUrl` itself when it is one URL, or the
 * listed URL with the request's origin. `undefined` when no listed URL has that origin. This is the rule `mcpAuth`,
 * `withMcpAuth`, and `protectedResourceMetadataHandler` apply to their `resourceUrl`, so use it in a protected resource
 * metadata route of your own, such as one for another authorization server, to keep its `resource` identical to the
 * URL they check, and answer `421` when it returns `undefined`.
 * @example
 * ```ts
 * const resource = matchResourceUrl(['https://mcp.example.com/mcp', 'https://mcp.example.dev/mcp'], request.url);
 * if (!resource) return new Response(null, { status: 421 });
 * ```
 */
export function matchResourceUrl(
  resourceUrl: string | readonly string[],
  requestUrl: string | URL,
): string | undefined {
  if (typeof resourceUrl === 'string') return resourceUrl;
  const { origin } = new URL(requestUrl);
  return resourceUrl.find((url) => URL.canParse(url) && new URL(url).origin === origin);
}

/**
 * CORS headers for OAuth metadata endpoints
 */
export const metadataCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};
