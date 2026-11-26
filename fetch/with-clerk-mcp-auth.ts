import type { AuthInfo } from '../mcp-types';
import {
  type ClerkEnv,
  type MiddlewareAuthOptions,
  assertMcpAuthOptions,
  assertVerifierOrResourceUrl,
  createBearerAuth,
  envClerkClient,
  protectedResourceMetadataAnswer,
  readJsonBody,
  serverErrorAnswer,
} from '../bearer-auth';
import { type McpAuthFailure, metadataCorsHeaders } from '../server';

// This module must stay free of any MCP SDK import (`sdk-free-entries.test.ts` checks it), so a Worker that serves MCP
// with its own handler, or none, installs no SDK to use `withClerkMcpAuth`.

/**
 * The part of a Cloudflare Workers `ExecutionContext` this package names. A Worker's own `ExecutionContext` is passed
 * on to the handler as it is.
 */
export type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

/**
 * One Worker request as `withClerkMcpAuth` received it: the request, and the `env` and `ctx` the Worker's `fetch`
 * was called with. `verifyToken` receives it, so a verifier can reach the Worker's bindings.
 */
export type McpFetchRequest<Env = ClerkEnv, Ctx = WorkerExecutionContext> = {
  request: Request;
  env: Env;
  ctx: Ctx;
};

/**
 * The handler `withClerkMcpAuth` wraps, called for each request that passed the auth check with its `authInfo`, and
 * the Worker's `env` and `ctx`. `authInfo` is `undefined` only for a request without a token that `publicAccess` let
 * through. Narrow it with `isClerkAuthInfo` before reading Clerk fields such as `extra.userId`.
 */
export type McpFetchHandler<Env = ClerkEnv, Ctx = WorkerExecutionContext> = (
  request: Request,
  context: { authInfo: AuthInfo | undefined; env: Env; ctx: Ctx },
) => Response | Promise<Response>;

type McpAuthFailureOption = {
  /**
   * Synchronously notifies why a request is about to be answered with a 401 or 403 challenge or a 421, for example
   * for logging. Return values are ignored. Pass asynchronous work to `ctx.waitUntil` to keep it alive after the
   * response; a promise returned here is not awaited.
   */
  onAuthFailure?: ((failure: McpAuthFailure, request: Request) => void) | undefined;
};

/**
 * Options for `withClerkMcpAuth`. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as its
 * audience, and `clerkClient` defaults to one built with `createClerkClient` from `@clerk/backend`, from
 * `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the Worker `env` passed to `fetch`, with `CLERK_API_URL`,
 * `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set, kept for each set of those settings. `process.env` is
 * never read. With `verifyToken`, that function verifies each token with the `McpFetchRequest`, `resourceUrl` is
 * optional, and `clerkClient` is not allowed. `onAuthFailure` is available either way.
 */
export type McpAuthOptions<Env = ClerkEnv, Ctx = WorkerExecutionContext> = McpAuthFailureOption &
  MiddlewareAuthOptions<McpFetchRequest<Env, Ctx>>;

const WELL_KNOWN = '/.well-known/oauth-protected-resource';

const withClerkMcpAuthCallForm =
  'withClerkMcpAuth(handler, { resourceUrl }), or as withClerkMcpAuth(handler, { verifyToken }) to verify tokens with your own function';

/**
 * Wraps a Worker's MCP handler so that every request needs a valid bearer token, and serves the RFC 9728 protected
 * resource metadata the challenge points to. By default Clerk verifies the OAuth access token, including that its
 * audience is this endpoint; pass `verifyToken` to verify tokens with your own function. It imports no MCP SDK, so
 * the handler can be any `fetch`-style MCP handler, such as `createMcpHandler` from `@modelcontextprotocol/server`.
 *
 * Route both the MCP endpoint and `/.well-known/oauth-protected-resource` (and the paths below it) to the wrapped
 * handler. A GET or HEAD there gets the metadata, with the publishable key read from the Worker's
 * `CLERK_PUBLISHABLE_KEY`, and an OPTIONS the CORS preflight; a request to an origin no listed `resourceUrl` has gets
 * a 421.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3
 * @see https://datatracker.ietf.org/doc/html/rfc6750#section-3
 * @param handler - The MCP handler, called with the request and `{ authInfo, env, ctx }`
 * @param options - See `McpAuthOptions`
 * @returns A function of `(request, env, ctx)`, the shape of a Worker's `fetch`. A missing or rejected token gets a
 * 401 challenge, a token without `requiredScopes` gets a 403 challenge, and `onAuthFailure` is told why. Otherwise
 * the handler is called with the auth info, with `resourceMetadataUrl` added for the SDK's scope challenges. A token
 * that could not be verified at all, such as during a Clerk outage, gets a JSON server error,
 * `{ "error": "server_error" }`, with Clerk's 429 or 5xx status or a 500, and the `McpAuthError` is logged with
 * `console.error`. Without a `clerkClient` option, a request throws a `Clerk error:` naming a key missing from the
 * Worker env, or asking to install `@clerk/backend` when it can't be loaded.
 * @example
 * ```ts
 * import { withClerkMcpAuth } from '@clerk/mcp-tools/fetch';
 *
 * const authedHandler = withClerkMcpAuth(mcpHandler, {
 *   resourceUrl: 'https://mcp.example.com/mcp',
 *   requiredScopes: ['profile', 'email'],
 * });
 *
 * export default {
 *   fetch(request, env, ctx) {
 *     const { pathname } = new URL(request.url);
 *     if (pathname === '/mcp' || pathname.startsWith('/.well-known/oauth-protected-resource')) {
 *       return authedHandler(request, env, ctx);
 *     }
 *     return app.fetch(request, env, ctx);
 *   },
 * } satisfies ExportedHandler<Env>;
 * ```
 */
export function withClerkMcpAuth<Env = ClerkEnv, Ctx = WorkerExecutionContext>(
  handler: McpFetchHandler<Env, Ctx>,
  options: McpAuthOptions<Env, Ctx>,
): (request: Request, env: Env, ctx: Ctx) => Promise<Response> {
  if (typeof handler !== 'function') {
    throw new Error(
      `Clerk error: withClerkMcpAuth from @clerk/mcp-tools/fetch takes the handler first. Call it as ${withClerkMcpAuthCallForm}`,
    );
  }
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: withClerkMcpAuth from @clerk/mcp-tools/fetch needs a resourceUrl to verify tokens with Clerk. Call it as ${withClerkMcpAuthCallForm}`,
  );
  assertMcpAuthOptions('withClerkMcpAuth', options, new Set(['onAuthFailure']));

  const authenticate = createBearerAuth(
    'withClerkMcpAuth from @clerk/mcp-tools/fetch',
    options,
    // Only the Worker env: Workers have no `process.env` to fall back to, so it is never read
    ({ env }: McpFetchRequest<Env, Ctx>) =>
      envClerkClient('withClerkMcpAuth', (env ?? {}) as ClerkEnv),
    'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY in the Worker env',
  );

  return async (request, env, ctx) => {
    const { pathname } = new URL(request.url);
    if (pathname === WELL_KNOWN || pathname.startsWith(`${WELL_KNOWN}/`)) {
      return metadataResponse(options, request, env);
    }

    const result = await authenticate(
      { request, env, ctx },
      {
        authorization: request.headers.get('authorization') ?? undefined,
        requestUrl: request.url,
        method: request.method,
        // A clone, so the handler can still read the request
        body: () => readJsonBody(request),
      },
    );
    if ('serverError' in result) {
      const answer = serverErrorAnswer(result.serverError);
      return Response.json(answer.body, { status: answer.status });
    }
    if (!result.ok) {
      // The notification must not delay the challenge or turn it into a server error
      if (result.failure) {
        try {
          void Promise.resolve(options.onAuthFailure?.(result.failure, request)).catch(() => {});
        } catch {}
      }
      return Response.json(result.body, result);
    }
    return handler(request, { authInfo: result.authInfo, env, ctx });
  };
}

// The protected resource metadata (RFC 9728 section 3), for the resource the requested well-known path describes
function metadataResponse(options: McpAuthOptions<never, never>, request: Request, env: unknown) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: metadataCorsHeaders });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, {
      status: 405,
      headers: { ...metadataCorsHeaders, Allow: 'GET, HEAD, OPTIONS' },
    });
  }
  const { resourceUrl, requiredScopes, challengeScopes } = options;
  const answer = protectedResourceMetadataAnswer(
    { resourceUrl, requiredScopes, challengeScopes },
    { publishableKey: ((env ?? {}) as ClerkEnv).CLERK_PUBLISHABLE_KEY, url: request.url },
  );
  return Response.json(answer.body, answer);
}
