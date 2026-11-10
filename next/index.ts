import type { AuthInfo } from '../mcp-types';
import {
  type ClerkAuthOptions,
  type CustomVerifierAuthOptions,
  type ProtectedResourceMetadataOptions,
  assertMcpAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertVerifierOrResourceUrl,
  authenticateBearer,
  clerkProtectedResourceMetadata,
  clerkTokenVerifier,
} from '../bearer-auth';
import {
  type ClerkOAuthClient,
  type McpAuthFailure,
  metadataCorsHeaders,
  fetchAuthorizationServerMetadata,
} from '../server';

export type { ProtectedResourceMetadataOptions };

// Everything in the core subpath, so a Next.js app imports from this subpath alone
export * from '../server';

/**
 * A Next.js route handler that serves RFC 9728 protected resource metadata for the Clerk instance named by
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Export it from the route at the path `withMcpAuth`'s challenge points to.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3
 * @param options - `resourceUrl`, the same value you give `withMcpAuth`, so the metadata's `resource` is the URL it
 * checks, and `properties`, additional metadata such as `scopes_supported`, which overrides the generated metadata.
 * Without `resourceUrl`, the `resource` is the URL the metadata route was requested at, without the well-known path.
 * @returns The handler. A request to an origin no listed `resourceUrl` has gets a 421. It throws when
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is not set.
 * @example
 * ```ts
 * const handler = protectedResourceMetadataHandler({ resourceUrl: "https://mcp.example.com/mcp" });
 *
 * export { handler as GET };
 * ```
 */
export function protectedResourceMetadataHandler(
  options: ProtectedResourceMetadataOptions = {},
): (req: Request) => Response {
  assertProtectedResourceMetadataOptions(options);

  return (req: Request): Response => {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = clerkProtectedResourceMetadata(options, req.url, publishableKey);
    if (!metadata) {
      return Response.json(
        { error: 'misdirected_request' },
        { status: 421, headers: metadataCorsHeaders },
      );
    }

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
export function authorizationServerMetadataHandler(): () => Promise<Response> {
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
export function metadataCorsHandler(): () => Response {
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
type McpRouteHandler = (req: Request) => Response | Promise<Response>;

type McpAuthFailureOption = {
  /**
   * Called with why a request is about to be answered with a 401 or 403 challenge or a 421, for example for logging.
   * A route wrapper has no request context to record it on, as the Express and Hono adapters do.
   */
  onAuthFailure?: ((failure: McpAuthFailure, req: Request) => unknown) | undefined;
};

/**
 * Options for `withMcpAuth`. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as its
 * audience, and `clerkClient` is required. With `verifyToken`, that function verifies each token with the request,
 * `resourceUrl` is optional, and `clerkClient` is not allowed. `onAuthFailure` is available either way.
 */
export type McpAuthOptions = McpAuthFailureOption &
  (
    | (ClerkAuthOptions & {
        /**
         * `clerkClient` from `@clerk/nextjs/server`, or a client created with both `secretKey` and `publishableKey`,
         * from `@clerk/backend` 3.19.0 or later, the first with a reliable audience check. It is an option, not an
         * import of this package, so that the rest of `@clerk/mcp-tools/next` builds without `@clerk/nextjs`.
         */
        clerkClient: ClerkOAuthClient | (() => Promise<ClerkOAuthClient>);
        verifyToken?: never;
      })
    | CustomVerifierAuthOptions<Request>
  );

const withMcpAuthCallForm =
  'withMcpAuth(handler, { resourceUrl, clerkClient }), or as withMcpAuth(handler, { verifyToken }) to verify tokens with your own function';

/**
 * Wraps a Next.js MCP route handler so that every request needs a valid bearer token. By default Clerk verifies the
 * OAuth access token, including that its audience is this endpoint; pass `verifyToken` to verify tokens with your own
 * function. Use it in place of `withMcpAuth` from `mcp-handler`.
 * @param handler - The route handler, such as the one `createMcpHandler` from `mcp-handler` returns
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, the `challengeScopes` the 401 challenge also asks for, either the `clerkClient` that verifies tokens or a
 * `verifyToken` function, and `onAuthFailure`, which is called with the reason for each request answered with a
 * challenge or a 421. `verifyToken` is called with the token and the request, and `resourceUrl` is optional with it.
 * @returns The wrapped route handler. A missing or rejected token gets a 401 challenge, and a token without
 * `requiredScopes` gets a 403 challenge. Otherwise the auth data is set on `req.auth`, where `mcp-handler` reads it,
 * with `resourceMetadataUrl` added for the SDK's scope challenges. When Clerk cannot verify an opaque token at all,
 * the handler throws, so Next.js answers with a 500 instead of a challenge that would make the client discard a valid
 * token.
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
 * @example
 * ```ts
 * // Verify tokens with your own function instead of Clerk
 * const authHandler = withMcpAuth(handler, {
 *   verifyToken: async (token, req) => verifyMyToken(token),
 *   resourceUrl: "https://mcp.example.com/mcp",
 * });
 * ```
 */
export function withMcpAuth(
  handler: McpRouteHandler,
  options: McpAuthOptions,
): (req: Request) => Promise<Response> {
  if (typeof handler !== 'function') {
    throw new Error(
      `Clerk error: withMcpAuth from @clerk/mcp-tools/next takes the route handler first. Call it as ${withMcpAuthCallForm}`,
    );
  }
  // `mcp-handler`'s `withMcpAuth` takes a verifier function here, so code moved from it fails at startup
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: withMcpAuth from @clerk/mcp-tools/next needs a resourceUrl to verify tokens with Clerk. Call it as ${withMcpAuthCallForm}`,
  );
  assertMcpAuthOptions('withMcpAuth', options);

  const verifyToken = options.verifyToken ?? clerkVerifier(options);

  return async (req) => {
    const result = await authenticateBearer({
      authorization: req.headers.get('authorization') ?? undefined,
      requestUrl: req.url,
      resourceUrl: options.resourceUrl,
      requiredScopes: options.requiredScopes,
      challengeScopes: options.challengeScopes,
      verifyToken: (token) => verifyToken(token, req),
    });

    if (!result.ok) {
      // A logging callback that throws or rejects must not turn the challenge into a server error
      try {
        const returned: unknown = options.onAuthFailure?.(result.failure, req);
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

// The verifier for the Clerk branch of the options, which checks the `clerkClient` option at startup
function clerkVerifier(options: Extract<McpAuthOptions, { clerkClient: unknown }>) {
  const { clerkClient } = options;
  if (typeof clerkClient !== 'function' && typeof clerkClient?.authenticateRequest !== 'function') {
    throw new Error(
      `Clerk error: withMcpAuth from @clerk/mcp-tools/next needs a clerkClient option. Import clerkClient from '@clerk/nextjs/server' and call ${withMcpAuthCallForm}`,
    );
  }
  return clerkTokenVerifier(
    options,
    () => (typeof clerkClient === 'function' ? clerkClient() : clerkClient),
    (req: Request) => req.url,
  );
}
