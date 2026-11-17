import type { AuthInfo } from '../mcp-types';
import {
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMcpAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertVerifierOrResourceUrl,
  authorizationServerMetadataAnswer,
  createBearerAuth,
  protectedResourceMetadataAnswer,
  readJsonBody,
  requireClerkEnvKeys,
  serverErrorAnswer,
} from '../bearer-auth';
import { type ClerkOAuthClient, type McpAuthFailure, metadataCorsHeaders } from '../server';

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions` of `withMcpAuth`, all optional, plus
 * `properties`, so one object, such as one exported from `lib/mcp.ts`, can be passed to both. The handler reads
 * `resourceUrl`, `requiredScopes`, `challengeScopes`, and `properties`, and ignores the other `McpAuthOptions` keys:
 * `clerkClient`, `verifyToken`, and `onAuthFailure`.
 */
export type ProtectedResourceMetadataOptions =
  SharedProtectedResourceMetadataOptions<McpAuthOptions>;

// Everything in the core subpath, so a Next.js app imports from this subpath alone
export * from '../server';

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
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is not set. Exporting `protectedResourceMetadataHandler` itself as `GET`,
 * without calling it, throws a `Clerk error:` on the first request.
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
  // Exported uncalled as `GET`, it is called with the request, which has no own keys and so passes as empty options
  if ((options as unknown) instanceof Request) {
    throw new Error(
      'Clerk error: call protectedResourceMetadataHandler({ resourceUrl }) and pass its result to the route, instead of passing protectedResourceMetadataHandler itself',
    );
  }
  // `onAuthFailure` is the one key of `withMcpAuth`'s options that the Express and Hono `mcpAuth` options do not have
  assertProtectedResourceMetadataOptions(options, new Set(['onAuthFailure']));

  return (req: Request): Response => {
    const answer = protectedResourceMetadataAnswer(options, {
      // `metadataCorsHandler` answers the preflight
      method: undefined,
      publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      keyName: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
      url: req.url,
    });
    return Response.json(answer.body, answer);
  };
}

/**
 * OAuth 2.0 Authorization Server Metadata endpoint based on RFC 8414
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 * @returns The `GET` handler. Exporting `authorizationServerMetadataHandler` itself as `GET`, without calling it,
 * throws a `Clerk error:` on the first request.
 */
export function authorizationServerMetadataHandler(): () => Promise<Response> {
  assertAuthorizationServerMetadataHandlerCalled(arguments.length);
  return async (): Promise<Response> => {
    const answer = await authorizationServerMetadataAnswer({
      method: undefined,
      publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      keyName: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    });
    return Response.json(answer.body, answer);
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
 * audience, and `clerkClient` defaults to `clerkClient` from `@clerk/nextjs/server`, loaded on the first request,
 * which needs `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` set. An app that passes its keys to
 * `clerkMiddleware()` instead, or runs in keyless mode, passes `clerkClient: () => clerkClient()` from
 * `@clerk/nextjs/server`, with the MCP route in the middleware's matcher. With `verifyToken`, that function verifies
 * each token with the request, `resourceUrl` is optional, and `clerkClient` is not allowed. `onAuthFailure` is
 * available either way.
 */
export type McpAuthOptions = McpAuthFailureOption & MiddlewareAuthOptions<Request>;

const withMcpAuthCallForm =
  'withMcpAuth(handler, { resourceUrl }), or as withMcpAuth(handler, { verifyToken }) to verify tokens with your own function';

/**
 * Wraps a Next.js MCP route handler so that every request needs a valid bearer token. By default Clerk verifies the
 * OAuth access token, including that its audience is this endpoint; pass `verifyToken` to verify tokens with your own
 * function. Use it in place of `withMcpAuth` from `mcp-handler`.
 * @param handler - The route handler, such as the one `createMcpHandler` from `mcp-handler` returns
 * @param options - See `McpAuthOptions`
 * @returns The wrapped route handler. A missing or rejected token gets a 401 challenge, and a token without
 * `requiredScopes` gets a 403 challenge, and `onAuthFailure` is told why. Otherwise the auth data is set on
 * `req.auth`, where `mcp-handler` reads it, with `resourceMetadataUrl` added for the SDK's scope challenges. Tools
 * read it as `ctx.http?.authInfo`, narrowed with `isClerkAuthInfo` before they read Clerk fields such as
 * `extra.userId`. A token that could not be verified at all, such as during a Clerk outage, gets a JSON server error,
 * `{ "error": "server_error" }`, with Clerk's 429 or 5xx status or a 500, and the `McpAuthError` is logged with
 * `console.error`. Without a `clerkClient` option, every request throws a `Clerk error:` naming a missing key, or
 * asking to install `@clerk/nextjs` when it can't be loaded.
 * @example
 * ```ts
 * import { withMcpAuth } from "@clerk/mcp-tools/next";
 *
 * const authHandler = withMcpAuth(handler, {
 *   resourceUrl: "https://mcp.example.com/mcp",
 *   requiredScopes: ["profile", "email"],
 * });
 *
 * export { authHandler as GET, authHandler as POST, authHandler as DELETE };
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

  const authFor = createBearerAuth(
    'withMcpAuth from @clerk/mcp-tools/next',
    options,
    nextClerkClient,
    "clerkClient from '@clerk/nextjs/server'",
  );

  return async (req) => {
    const authenticate = await authFor(req);
    const result = await authenticate({
      authorization: req.headers.get('authorization') ?? undefined,
      requestUrl: req.url,
      method: req.method,
      // A clone, so the route handler can still read the request
      body: () => readJsonBody(req),
    });
    if ('serverError' in result) {
      // Answered here with the status and body the Express and Hono adapters send. Next.js's `onRequestError` no
      // longer sees it, so `serverErrorAnswer` logs it with `console.error`, as it does for those adapters.
      const answer = serverErrorAnswer(result.serverError);
      return Response.json(answer.body, { status: answer.status });
    }
    if (!result.ok) {
      // The notification must not delay the challenge or turn it into a server error
      if (result.failure) {
        try {
          // `void` callback positions still accept async functions. Guard accidentally returned promises and thenables
          void Promise.resolve(options.onAuthFailure?.(result.failure, req)).catch(() => {});
        } catch {}
      }
      return Response.json(result.body, result);
    }

    // `mcp-handler` passes `req.auth` to its transport, as its own `withMcpAuth` does. It is `undefined` for a
    // request without a token that `publicAccess` let through.
    (req as Request & { auth?: AuthInfo }).auth = result.authInfo;
    return handler(req);
  };
}

/**
 * `clerkClient()` from `@clerk/nextjs/server`. The package is an optional peer that only this path needs, so it is
 * loaded with `import()` inside `try`: webpack and Turbopack fail the build on a bare reference to a package that
 * isn't installed, but only warn on an `import()` inside `try`, and leave it to fail at run time.
 * @returns The client. It throws a `Clerk error:` asking to install `@clerk/nextjs` when the package can't be loaded,
 * with the load error as the `cause`, or naming `CLERK_SECRET_KEY` or `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` when it is
 * not set.
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
  // `@clerk/backend` checks the keys only when a token is verified, and a missing one would then look like a Clerk
  // outage once the client has authorized, so they are checked here as the Express and Hono adapters check theirs.
  // Each is written out, not looked up by name: Next.js inlines `process.env.NEXT_PUBLIC_*` only where it is written
  // out, so a publishable key set only at build time is missing from `process.env[name]` at run time.
  requireClerkEnvKeys('withMcpAuth', {
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  });
  return nextjs.clerkClient();
}
