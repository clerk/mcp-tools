import type { AuthInfo } from '../mcp-types';
import {
  type ClerkAuthOptions,
  type CustomVerifierAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMcpAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertVerifierOrResourceUrl,
  authenticateBearer,
  clerkProtectedResourceMetadata,
  clerkTokenVerifier,
  failureHeaders,
  readJsonBody,
  requirePublishableKey,
} from '../bearer-auth';
import {
  type ClerkOAuthClient,
  type McpAuthFailure,
  metadataCorsHeaders,
  fetchAuthorizationServerMetadata,
} from '../server';

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions` of `withMcpAuth`, all optional, plus
 * `properties`, so one object, such as one exported from `lib/mcp.ts`, can be passed to both. The handler reads
 * `resourceUrl`, `requiredScopes`, `challengeScopes`, and `properties`, and ignores the other `McpAuthOptions` keys:
 * `clerkClient`, `verifyToken`, and `onAuthFailure`.
 */
export type ProtectedResourceMetadataOptions =
  SharedProtectedResourceMetadataOptions<McpAuthOptions>;

// The keys of `withMcpAuth`'s options that the Express and Hono `mcpAuth` options do not have
const withMcpAuthOnlyOptionKeys: ReadonlySet<string> = new Set<keyof McpAuthFailureOption>([
  'onAuthFailure',
]);

// Everything in the core subpath, so a Next.js app imports from this subpath alone
export * from '../server';

// The headers of a metadata handler's successful response
const metadataResponseHeaders = {
  'Cache-Control': 'max-age=3600',
  'Content-Type': 'application/json',
  ...metadataCorsHeaders,
};

/**
 * A Next.js route handler that serves RFC 9728 protected resource metadata for the Clerk instance named by
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Export it from the route at the path `withMcpAuth`'s challenge points to.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3
 * @param options - The options you give `withMcpAuth`, and `properties`, additional metadata such as
 * `resource_name`, which overrides the generated metadata. `resourceUrl` makes the metadata's `resource` the URL
 * `withMcpAuth` checks; without it, the `resource` is the URL the metadata route was requested at, without the
 * well-known path. `scopes_supported` lists `requiredScopes` then `challengeScopes`, unless `properties` sets it, and
 * then that list must include each of them.
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
  assertProtectedResourceMetadataOptions(options, withMcpAuthOnlyOptionKeys);

  return (req: Request): Response => {
    const publishableKey = requirePublishableKey(
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    );

    const metadata = clerkProtectedResourceMetadata(options, req.url, publishableKey);
    if (!metadata) {
      return Response.json(
        { error: 'misdirected_request' },
        { status: 421, headers: metadataCorsHeaders },
      );
    }

    return Response.json(metadata, { headers: metadataResponseHeaders });
  };
}

/**
 * OAuth 2.0 Authorization Server Metadata endpoint based on RFC 8414
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 * @returns The `GET` handler. Exporting `authorizationServerMetadataHandler` itself as `GET`, without calling it,
 * throws a `Clerk error:` on the first request.
 */
export function authorizationServerMetadataHandler(): () => Promise<Response> {
  // `arguments`, not a rest parameter, so the declared signature still takes no arguments
  assertAuthorizationServerMetadataHandlerCalled(arguments.length);
  return async (): Promise<Response> => {
    const publishableKey = requirePublishableKey(
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    );

    const metadata = await fetchAuthorizationServerMetadata({
      publishableKey,
    });

    return Response.json(metadata, { headers: metadataResponseHeaders });
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
   * Synchronously notifies why a request is about to be answered with a 401 or 403 challenge or a 421, for example
   * for logging. A route wrapper has no request context to record it on, as the Express and Hono adapters do.
   * Return values are ignored. Schedule asynchronous work with `after()` from `next/server` to keep it alive after
   * the response; a promise returned here is not awaited or registered with the request lifecycle.
   */
  onAuthFailure?: ((failure: McpAuthFailure, req: Request) => void) | undefined;
};

/**
 * Options for `withMcpAuth`. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as its
 * audience, and `clerkClient` defaults to `clerkClient` from `@clerk/nextjs/server`. With `verifyToken`, that function
 * verifies each token with the request, `resourceUrl` is optional, and `clerkClient` is not allowed. `onAuthFailure`
 * is available either way.
 */
export type McpAuthOptions = McpAuthFailureOption &
  (
    | (ClerkAuthOptions & {
        /**
         * The client that verifies tokens. Defaults to `clerkClient` from `@clerk/nextjs/server`, loaded on the first
         * request. Pass a client created with both `secretKey` and `publishableKey`, from `@clerk/backend` 3.19.0 or
         * later, the first with a reliable audience check, to verify with another Clerk instance.
         */
        clerkClient?: ClerkOAuthClient | (() => Promise<ClerkOAuthClient>) | undefined;
        verifyToken?: never;
      })
    | CustomVerifierAuthOptions<Request>
  );

const withMcpAuthCallForm =
  'withMcpAuth(handler, { resourceUrl }), or as withMcpAuth(handler, { verifyToken }) to verify tokens with your own function';

/**
 * Wraps a Next.js MCP route handler so that every request needs a valid bearer token. By default Clerk verifies the
 * OAuth access token, including that its audience is this endpoint; pass `verifyToken` to verify tokens with your own
 * function. Use it in place of `withMcpAuth` from `mcp-handler`.
 * @param handler - The route handler, such as the one `createMcpHandler` from `mcp-handler` returns
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, the `challengeScopes` the 401 challenge also asks for, either the `clerkClient` that verifies tokens or a
 * `verifyToken` function, and `onAuthFailure`, a synchronous notification with the reason for each request answered
 * with a challenge or a 421. `clerkClient` defaults to `clerkClient` from `@clerk/nextjs/server`, loaded on the first
 * request. `verifyToken` is called with the token and the request, and `resourceUrl` is optional with it.
 * @returns The wrapped route handler. A missing or rejected token gets a 401 challenge, and a token without
 * `requiredScopes` gets a 403 challenge. Otherwise the auth data is set on `req.auth`, where `mcp-handler` reads it,
 * with `resourceMetadataUrl` added for the SDK's scope challenges. When Clerk cannot verify an opaque token at all,
 * the handler throws, so Next.js answers with a 500 instead of a challenge that would make the client discard a valid
 * token. Without a `clerkClient` option, every request throws a `Clerk error:` when `@clerk/nextjs` can't be loaded.
 * @example
 * ```ts
 * import { withMcpAuth } from "@clerk/mcp-tools/next";
 *
 * const authHandler = withMcpAuth(handler, {
 *   resourceUrl: "https://mcp.example.com/mcp",
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

  const clerkClientFor = clerkClientResolver(options);
  const verifyToken =
    options.verifyToken ?? clerkTokenVerifier(options, clerkClientFor, (req: Request) => req.url);

  return async (req) => {
    // A missing Clerk client is a mistake in the app's setup, so it is thrown as it is, on a request with or without
    // a token. Thrown by the verifier, it would be the `cause` of an `McpAuthError`, and only once a token arrives.
    if (!options.verifyToken) await clerkClientFor();

    const result = await authenticateBearer({
      authorization: req.headers.get('authorization') ?? undefined,
      requestUrl: req.url,
      resourceUrl: options.resourceUrl,
      requiredScopes: options.requiredScopes,
      challengeScopes: options.challengeScopes,
      publicAccess: options.publicAccess,
      method: req.method,
      // A clone, so the route handler can still read the request
      body: () => readJsonBody(req),
      verifyToken: (token) => verifyToken(token, req),
    });

    if (!result.ok) {
      const { failure } = result;
      // The notification must not delay the challenge or turn it into a server error
      if (failure) {
        try {
          // `void` callback positions still accept async functions. Guard accidentally returned promises and thenables
          void Promise.resolve(options.onAuthFailure?.(failure, req)).catch(() => {});
        } catch {}
      }
      return Response.json(
        { error: result.error },
        { status: result.status, headers: failureHeaders(result) },
      );
    }

    // `mcp-handler` passes `req.auth` to its transport, as its own `withMcpAuth` does. It is `undefined` for a
    // request without a token that `publicAccess` let through.
    (req as Request & { auth?: AuthInfo }).auth = result.authInfo;
    return handler(req);
  };
}

/**
 * Returns the Clerk client for the Clerk branch of the options: the `clerkClient` option, checked at startup, or
 * `clerkClient` from `@clerk/nextjs/server`, loaded on the first request.
 * @param options - `withMcpAuth`'s options. With `verifyToken`, `clerkClient` is never set and the result is unused.
 * @returns A function that resolves the client for a request
 */
function clerkClientResolver({ clerkClient }: Pick<McpAuthOptions, 'clerkClient'>) {
  if (clerkClient === undefined) return nextClerkClient;
  if (typeof clerkClient !== 'function' && typeof clerkClient?.authenticateRequest !== 'function') {
    throw new Error(
      `Clerk error: withMcpAuth from @clerk/mcp-tools/next takes a clerkClient with authenticateRequest, or a function that returns one. Omit clerkClient to use clerkClient from '@clerk/nextjs/server', or call it as ${withMcpAuthCallForm}`,
    );
  }
  return async (): Promise<ClerkOAuthClient> =>
    typeof clerkClient === 'function' ? clerkClient() : clerkClient;
}

/**
 * `clerkClient()` from `@clerk/nextjs/server`. The package is an optional peer that only this path needs, so it is
 * loaded with `import()` inside `try`: webpack and Turbopack fail the build on a bare reference to a package that
 * isn't installed, but only warn on an `import()` inside `try`, and leave it to fail at run time.
 * @returns The client. It throws a `Clerk error:` asking to install `@clerk/nextjs` when the package can't be loaded,
 * with the load error as the `cause`.
 */
async function nextClerkClient(): Promise<ClerkOAuthClient> {
  let nextjs: typeof import('@clerk/nextjs/server');
  try {
    nextjs = await import('@clerk/nextjs/server');
  } catch (error) {
    throw new Error('Clerk error: install @clerk/nextjs, or pass clerkClient to withMcpAuth', {
      cause: error,
    });
  }
  return nextjs.clerkClient();
}
