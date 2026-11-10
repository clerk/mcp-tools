import type { AuthInfo } from './mcp-types';

/**
 * The fields `toClerkAuthInfo` reads from Clerk's auth object for an OAuth access token, the result of
 * `auth({ acceptsToken: 'oauth_token' })` or of a request state's `toAuth()`. Declared here so that this package's
 * types do not need `@clerk/backend`, which an app using `@clerk/express`, `@clerk/hono`, or `@clerk/nextjs` may not
 * list itself.
 */
export type ClerkOAuthAuthObject = {
  isAuthenticated: boolean;
  tokenType: string | null;
  userId?: string | null | undefined;
  clientId?: string | null | undefined;
  scopes?: string[] | null | undefined;
};

/**
 * Input to `generateProtectedResourceMetadata`: a Clerk publishable key, or the issuer identifier of any other
 * authorization server, never both.
 */
type GenerateProtectedResourceMetadataOptions =
  | {
      /**
       * Clerk publishable key. The authorization server is the instance's Frontend API, and Clerk's documentation is
       * added as `resource_documentation`.
       */
      publishableKey: string;
      authServerUrl?: never;
      /**
       * Resource identifier of the protected resource
       */
      resourceUrl: string;
      /**
       * Additional properties to include in the metadata. They override the generated ones.
       */
      properties?: Record<string, unknown>;
    }
  | {
      /**
       * Issuer identifier of the authorization server
       */
      authServerUrl: string;
      publishableKey?: never;
      /**
       * Resource identifier of the protected resource
       */
      resourceUrl: string;
      /**
       * Additional properties to include in the metadata. They override the generated ones.
       */
      properties?: Record<string, unknown>;
    };

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
 * @returns The parsed metadata document
 */
export async function fetchAuthorizationServerMetadata({
  publishableKey,
}: {
  publishableKey: string;
}) {
  const fapiUrl = deriveFapiUrl(publishableKey);

  return fetch(`${fapiUrl}/.well-known/oauth-authorization-server`)
    .then((res) => res.json())
    .then((metadata) => {
      return metadata;
    });
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
 * listed URL with the request's origin. `undefined` when no listed URL has that origin. This is the rule `mcpAuth` and
 * `mcpAuthClerk` apply to their `resourceUrl`, so use it in the protected resource metadata route to keep its
 * `resource` identical to the URL they check, and answer `421` when it returns `undefined`.
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
