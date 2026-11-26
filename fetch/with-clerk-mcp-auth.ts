import type { AuthInfo } from '../mcp-types';
import {
  type ClerkEnv,
  type MiddlewareAuthOptions,
  PROTECTED_RESOURCE_WELL_KNOWN,
  type ProtectedResourceMetadataOptions,
  assertMcpAuthOptions,
  assertVerifierOrResourceUrl,
  createBearerAuth,
  envClerkClient,
  protectedResourceMetadataAnswer,
  readJsonBody,
  resourceMetadataUrlFor,
  serverErrorAnswer,
} from '../bearer-auth';
import { methodAnswer } from '../discovery-response';
import { type McpResourceUrl, matchResourceUrl } from '../resource-url';
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
 * the Worker's `env` and `ctx`. `authInfo` is `undefined` only for a request without a token that `discoverable` or
 * `publicAccess` let through. Narrow it with `isClerkAuthInfo` before reading Clerk fields such as `extra.userId`.
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

const withClerkMcpAuthCaller = 'withClerkMcpAuth from @clerk/mcp-tools/fetch';
const withClerkMcpAuthCallForm =
  'withClerkMcpAuth(handler, { resourceUrl }), or as withClerkMcpAuth(handler, { verifyToken }) to verify tokens with your own function';

/**
 * Wraps a Worker's MCP handler so that every request needs a valid bearer token, and serves the RFC 9728 protected
 * resource metadata the challenge points to. By default Clerk verifies the OAuth access token, including that its
 * audience is this endpoint; pass `verifyToken` to verify tokens with your own function. It imports no MCP SDK, so
 * the handler can be any `fetch`-style MCP handler, such as `createMcpHandler` from `@modelcontextprotocol/server`.
 *
 * Route both the MCP endpoint and its metadata URL (RFC 9728 section 3.1: `/.well-known/oauth-protected-resource`
 * followed by the endpoint's path and query) to the wrapped handler. A GET or HEAD there gets the metadata, with the
 * publishable key read from the Worker's `CLERK_PUBLISHABLE_KEY`, an OPTIONS the CORS preflight, and another method a
 * 405 with `Cache-Control: no-store`; a request to an origin no listed `resourceUrl` has gets a 421. Any other path or
 * query, such as the bare well-known root, goes through the auth check to the handler. Without `resourceUrl`, any
 * path below the well-known prefix gets the metadata for the resource it describes.
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
 *     if (pathname === '/mcp' || pathname === '/.well-known/oauth-protected-resource/mcp') {
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
      `Clerk error: ${withClerkMcpAuthCaller} takes the handler first. Call it as ${withClerkMcpAuthCallForm}`,
    );
  }
  return fetchMcpAuth(handler, options, withClerkMcpAuthCaller, withClerkMcpAuthCallForm);
}

/**
 * `withClerkMcpAuth` without its handler check, with the entry point its messages name: `createClerkMcpWorker` uses
 * it so a missing key or option names the function the Worker called.
 * @param caller - The entry point named in the messages, such as `withClerkMcpAuth from @clerk/mcp-tools/fetch`
 * @param callForm - How to call that entry point, for the messages that say so
 */
export function fetchMcpAuth<Env, Ctx>(
  handler: McpFetchHandler<Env, Ctx>,
  options: McpAuthOptions<Env, Ctx>,
  caller: string,
  callForm: string,
): (request: Request, env: Env, ctx: Ctx) => Promise<Response> {
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: ${caller} needs a resourceUrl to verify tokens with Clerk. Call it as ${callForm}`,
  );
  assertMcpAuthOptions(caller, options, new Set(['onAuthFailure']));

  const authenticate = createBearerAuth(
    caller,
    options,
    // Only the Worker env: Workers have no `process.env` to fall back to, so it is never read
    ({ env }: McpFetchRequest<Env, Ctx>) =>
      envClerkClient(caller, (env ?? {}) as ClerkEnv, 'variable in the Worker env'),
    'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY in the Worker env',
  );

  const isMetadataRequest = metadataRoute(options.resourceUrl);

  return async (request, env, ctx) => {
    if (isMetadataRequest(request.url)) {
      return metadataResponse(
        options,
        request,
        (env as ClerkEnv | undefined)?.CLERK_PUBLISHABLE_KEY,
      );
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
          // `void` callback positions still accept async functions. Guard accidentally returned promises and thenables
          void Promise.resolve(options.onAuthFailure?.(result.failure, request)).catch(() => {});
        } catch {}
      }
      return Response.json(result.body, result);
    }
    return handler(request, { authInfo: result.authInfo, env, ctx });
  };
}

// The path and query of a URL, which together pick a resource's metadata URL (RFC 9728 section 3)
const pathAndQuery = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

// The path and query of a resource's metadata URL (RFC 9728 section 3.1)
const metadataPath = (resourceUrl: string) => pathAndQuery(resourceMetadataUrlFor(resourceUrl));

/**
 * Whether a request URL is one this entry answers with the protected resource metadata. RFC 9728 section 3.3 has a
 * client discard metadata whose `resource` is not the URL it inserted the well-known path into, so with `resourceUrl`
 * only the metadata path and query of the listed URL for the request's origin is answered, or for an origin no listed
 * URL has, the metadata path and query of any listed URL, which gets the 421. Every other path or query, such as the
 * bare well-known root, is the Worker's. Without `resourceUrl` the resource is derived from the requested path, so any
 * path below the well-known prefix is answered.
 */
function metadataRoute(resourceUrl: McpResourceUrl | undefined) {
  if (resourceUrl === undefined) {
    return (url: string) => {
      const { pathname } = new URL(url);
      return (
        pathname === PROTECTED_RESOURCE_WELL_KNOWN ||
        pathname.startsWith(`${PROTECTED_RESOURCE_WELL_KNOWN}/`)
      );
    };
  }
  const paths = new Set([resourceUrl].flat().map(metadataPath));
  return (url: string) => {
    const requested = pathAndQuery(url);
    if (!paths.has(requested)) return false;
    const resource = matchResourceUrl(resourceUrl, url);
    return resource === undefined || metadataPath(resource) === requested;
  };
}

// The protected resource metadata (RFC 9728 section 3) for the listed `resourceUrl` of the request's origin, or
// without `resourceUrl` for the resource the requested metadata URL describes
function metadataResponse(
  options: Pick<
    ProtectedResourceMetadataOptions,
    'resourceUrl' | 'requiredScopes' | 'challengeScopes'
  >,
  request: Request,
  publishableKey: string | undefined,
) {
  const notServed = methodAnswer(request.method, metadataCorsHeaders);
  if (notServed) return new Response(notServed.body, notServed);
  const { resourceUrl, requiredScopes, challengeScopes } = options;
  const answer = protectedResourceMetadataAnswer(
    { resourceUrl, requiredScopes, challengeScopes },
    { publishableKey, url: request.url },
  );
  return Response.json(answer.body, answer);
}
