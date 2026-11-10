import type { ClerkClient } from '@clerk/backend';
import type { AuthInfo } from '../mcp-types';
import {
  type McpAuthClerkOptions,
  type McpAuthFailure,
  type McpAuthOptions,
  type McpResourceUrl,
  McpAuthError,
  McpTokenVerificationError,
  assertMcpAuthClerkOptions,
  assertMcpAuthOptions,
  audienceFor,
  authenticateBearer,
  verifyClerkOAuthToken,
} from '../bearer-auth';
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  requireAdditionalScopes,
  verifyClerkToken,
} from '../server';

/**
 * OAuth 2.0 Protected Resource Metadata endpoint based on RFC 9728
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 * @param authServerUrl - The URL of the OAuth 2.0 Authorization Server.
 * @param properties - Additional properties to include in the metadata, such as the `resource` that matches the
 * `resourceUrl` of `mcpAuth`.
 */
export function protectedResourceHandler({
  authServerUrl,
  properties,
}: {
  authServerUrl: string;
  properties?: Record<string, unknown>;
}): (req: Request) => Response {
  return (req: Request): Response => {
    const metadata = generateProtectedResourceMetadata({
      authServerUrl: authServerUrl,
      resourceUrl: getResourceUrl(req),
      properties,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          'Cache-Control': 'max-age=3600',
          'Content-Type': 'application/json',
        },
        corsHeaders,
      ),
    });
  };
}

/**
 * OAuth 2.0 Protected Resource Metadata endpoint based on RFC 9728
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 *
 */
export function protectedResourceHandlerClerk(
  properties?: Record<string, unknown>,
): (req: Request) => Response {
  return (req: Request): Response => {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: getResourceUrl(req),
      properties,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          'Cache-Control': 'max-age=3600',
          'Content-Type': 'application/json',
        },
        corsHeaders,
      ),
    });
  };
}

/**
 * OAuth 2.0 Authorization Server Metadata endpoint based on RFC 8414
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */
export function authServerMetadataHandlerClerk(): () => Promise<Response> {
  return async (): Promise<Response> => {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = await fetchClerkAuthorizationServerMetadata({
      publishableKey,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          'Cache-Control': 'max-age=3600',
          'Content-Type': 'application/json',
        },
        corsHeaders,
      ),
    });
  };
}

/**
 * CORS options request handler for OAuth metadata endpoints. Necessary for MCP
 * clients that operate in web browsers.
 */
export function metadataCorsOptionsRequestHandler(): () => Response {
  return (): Response => {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  };
}

/**
 * A Next.js route handler, such as the one `createMcpHandler` from `mcp-handler` returns.
 */
export type McpRouteHandler = (req: Request) => Response | Promise<Response>;

type McpAuthFailureOption = {
  /**
   * Called with why a request is about to be answered with a 401 or 403 challenge or a 421, for example for logging.
   * A route wrapper has no request context to record it on, as the Express and Hono adapters do.
   */
  onAuthFailure?: ((failure: McpAuthFailure, req: Request) => void) | undefined;
};

/**
 * Wraps a Next.js MCP route handler so that every request needs a valid bearer token.
 * @param verifyToken - Verifies a token and returns the auth data, or `undefined` to reject it
 * @param options - The public `resourceUrl` of this endpoint, the `requiredScopes` every request needs, and
 * `onAuthFailure`, which is called with the reason for each request answered with a challenge or a 421
 * @returns A function that wraps the route handler. A missing or rejected token gets a 401 challenge, and a token
 * without `requiredScopes` gets a 403 challenge. Otherwise the auth data is set on `req.auth`, where `mcp-handler`
 * reads it, with `resourceMetadataUrl` added for the SDK's scope challenges.
 * @example
 * ```ts
 * const handler = createMcpHandler((server) => {
 *   // define server tools, resources, etc...
 * });
 *
 * const authHandler = mcpAuth(verifyToken, {
 *   resourceUrl: "https://mcp.example.com/mcp",
 * })(handler);
 *
 * export { authHandler as GET, authHandler as POST };
 * ```
 */
export function mcpAuth(
  verifyToken: (token: string, req: Request) => Promise<AuthInfo | undefined>,
  options?: McpAuthOptions & McpAuthFailureOption,
): (handler: McpRouteHandler) => (req: Request) => Promise<Response> {
  assertMcpAuthOptions('mcpAuth', options);

  return (handler) => async (req) => {
    const result = await authenticateBearer({
      authorization: req.headers.get('authorization') ?? undefined,
      requestUrl: req.url,
      resourceUrl: options?.resourceUrl,
      requiredScopes: options?.requiredScopes,
      challengeScopes: options?.challengeScopes,
      verifyToken: (token) => verifyToken(token, req),
    });

    if (!result.ok) {
      options?.onAuthFailure?.(result.failure, req);
      return Response.json(
        { error: result.error },
        {
          status: result.status,
          headers: result.challenge ? { 'WWW-Authenticate': result.challenge } : undefined,
        },
      );
    }

    // `mcp-handler` passes `req.auth` to its transport, as its own `withMcpAuth` does
    (req as Request & { auth?: AuthInfo }).auth = result.authInfo;
    return handler(req);
  };
}

/**
 * Wraps a Next.js MCP route handler so that every request needs an OAuth access token that Clerk verifies, including
 * that its audience is this endpoint.
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, the `clerkClient` that verifies tokens, and `onAuthFailure`, as for `mcpAuth`. The client defaults to
 * `clerkClient()` from `@clerk/nextjs/server`. Create another client with both `secretKey` and `publishableKey`, from
 * `@clerk/backend` 3.19.0 or later, the first with a reliable audience check.
 * @returns A function that wraps the route handler. A missing or rejected token gets a 401 challenge, and a token
 * without `requiredScopes` gets a 403 challenge. When Clerk cannot verify an opaque token at all, the handler throws,
 * so Next.js answers with a 500 instead of a challenge that would make the client discard a valid token.
 * @example
 * ```ts
 * const authHandler = mcpAuthClerk({
 *   resourceUrl: "https://mcp.example.com/mcp",
 *   requiredScopes: ["profile", "email"],
 * })(handler);
 *
 * export { authHandler as GET, authHandler as POST };
 * ```
 */
export function mcpAuthClerk(
  options: McpAuthClerkOptions &
    McpAuthFailureOption & {
      clerkClient?: Pick<ClerkClient, 'authenticateRequest'> | undefined;
    },
): (handler: McpRouteHandler) => (req: Request) => Promise<Response> {
  assertMcpAuthClerkOptions(options);

  return mcpAuth(async (token, req) => {
    // Imported lazily so that the rest of this entry point works without `@clerk/nextjs`
    const client =
      options.clerkClient ?? (await (await import('@clerk/nextjs/server')).clerkClient());
    return verifyClerkOAuthToken(client, token, audienceFor(options.resourceUrl, req.url));
  }, options);
}

// The resource a protected resource metadata route describes: `/mcp` for `/.well-known/oauth-protected-resource/mcp`,
// and the bare origin for the root route.
function getResourceUrl(req: Request): string {
  const { origin, pathname } = new URL(req.url);
  const resourcePath = pathname.replace('/.well-known/oauth-protected-resource', '');
  return `${origin}${resourcePath.replace(/\/$/, '')}`;
}

// re-export the verifyClerkToken function for convenience
export {
  McpAuthError,
  type McpAuthClerkOptions,
  type McpAuthFailure,
  type McpAuthOptions,
  type McpResourceUrl,
  McpTokenVerificationError,
  requireAdditionalScopes,
  verifyClerkToken,
};
