import type { AuthInfo } from '../mcp-types';
import {
  type ClerkOAuthClient,
  type McpAuthClerkOptions,
  type McpAuthFailure,
  type McpAuthOptions,
  type McpResourceUrl,
  McpAuthError,
  McpTokenVerificationError,
  assertMcpAuthOptions,
  audienceFor,
  authenticateBearer,
  resourceFromMetadataUrl,
  verifyClerkOAuthToken,
} from '../bearer-auth';
import {
  metadataCorsHeaders,
  fetchAuthorizationServerMetadata,
  generateProtectedResourceMetadata,
  requireAdditionalScopes,
  toClerkAuthInfo,
} from '../server';

/**
 * OAuth 2.0 Protected Resource Metadata endpoint based on RFC 9728
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 *
 */
export function protectedResourceHandler(
  properties?: Record<string, unknown>,
): (req: Request) => Response {
  return (req: Request): Response => {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = generateProtectedResourceMetadata({
      publishableKey,
      resourceUrl: resourceFromMetadataUrl(req.url),
      properties,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          'Cache-Control': 'max-age=3600',
          'Content-Type': 'application/json',
        },
        metadataCorsHeaders,
      ),
    });
  };
}

/**
 * OAuth 2.0 Authorization Server Metadata endpoint based on RFC 8414
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */
export function authServerMetadataHandler(): () => Promise<Response> {
  return async (): Promise<Response> => {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = await fetchAuthorizationServerMetadata({
      publishableKey,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          'Cache-Control': 'max-age=3600',
          'Content-Type': 'application/json',
        },
        metadataCorsHeaders,
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
      headers: metadataCorsHeaders,
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
  onAuthFailure?: ((failure: McpAuthFailure, req: Request) => unknown) | undefined;
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
      // A logging callback that throws or rejects must not turn the challenge into a server error
      try {
        const returned: unknown = options?.onAuthFailure?.(result.failure, req);
        if (returned instanceof Promise) returned.catch(() => {});
      } catch {}
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
 * Options for `withMcpAuth`.
 */
export type WithMcpAuthOptions = McpAuthClerkOptions &
  McpAuthFailureOption & {
    /**
     * `clerkClient` from `@clerk/nextjs/server`, or a client created with both `secretKey` and `publishableKey`, from
     * `@clerk/backend` 3.19.0 or later, the first with a reliable audience check. It is an option, not an import of
     * this package, so that the rest of `@clerk/mcp-tools/next` builds without `@clerk/nextjs`.
     */
    clerkClient: ClerkOAuthClient | (() => Promise<ClerkOAuthClient>);
  };

const withMcpAuthCallForm = 'withMcpAuth(handler, { resourceUrl, clerkClient })';

/**
 * Wraps a Next.js MCP route handler so that every request needs an OAuth access token that Clerk verifies, including
 * that its audience is this endpoint. Use it in place of `withMcpAuth` from `mcp-handler`.
 * @param handler - The route handler, such as the one `createMcpHandler` from `mcp-handler` returns
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, the `challengeScopes` the 401 challenge also asks for, the `clerkClient` that verifies tokens, and
 * `onAuthFailure`, as for `mcpAuth`
 * @returns The wrapped route handler. A missing or rejected token gets a 401 challenge, and a token without
 * `requiredScopes` gets a 403 challenge. When Clerk cannot verify an opaque token at all, the handler throws, so
 * Next.js answers with a 500 instead of a challenge that would make the client discard a valid token.
 * @example
 * ```ts
 * import { withMcpAuth } from "@clerk/mcp-tools/next";
 * import { clerkClient } from "@clerk/nextjs/server";
 *
 * const authHandler = withMcpAuth(handler, {
 *   resourceUrl: "https://mcp.example.com/mcp",
 *   clerkClient,
 *   requiredScopes: ["profile", "email"],
 * });
 *
 * export { authHandler as GET, authHandler as POST };
 * ```
 */
export function withMcpAuth(
  handler: McpRouteHandler,
  options: WithMcpAuthOptions,
): (req: Request) => Promise<Response> {
  if (typeof handler !== 'function') {
    throw new Error(
      `Clerk error: withMcpAuth from @clerk/mcp-tools/next takes the route handler first. Call it as ${withMcpAuthCallForm}`,
    );
  }
  // `mcp-handler`'s `withMcpAuth` takes a verifier function here, so code moved from it fails at startup
  if (typeof options?.resourceUrl !== 'string' && !Array.isArray(options?.resourceUrl)) {
    throw new Error(
      `Clerk error: withMcpAuth from @clerk/mcp-tools/next needs a resourceUrl and verifies tokens with Clerk itself. Call it as ${withMcpAuthCallForm}`,
    );
  }
  assertMcpAuthOptions('withMcpAuth', options);
  const { clerkClient } = options;
  if (typeof clerkClient !== 'function' && typeof clerkClient?.authenticateRequest !== 'function') {
    throw new Error(
      `Clerk error: withMcpAuth from @clerk/mcp-tools/next needs a clerkClient option. Import clerkClient from '@clerk/nextjs/server' and call ${withMcpAuthCallForm}`,
    );
  }

  return mcpAuth(async (token, req) => {
    const client = typeof clerkClient === 'function' ? await clerkClient() : clerkClient;
    return verifyClerkOAuthToken(client, token, audienceFor(options.resourceUrl, req.url));
  }, options)(handler);
}

// re-export toClerkAuthInfo for convenience
export {
  type ClerkOAuthClient,
  McpAuthError,
  type McpAuthClerkOptions,
  type McpAuthFailure,
  type McpAuthOptions,
  type McpResourceUrl,
  McpTokenVerificationError,
  requireAdditionalScopes,
  toClerkAuthInfo,
};
