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
import {
  type ReportingOption,
  AUTH_FAILURE_BODY_LIMIT,
  beginToolCallContext,
  flushAfterResponse,
  hashSessionId,
  reportAuthFailure,
  resolveReporting,
} from '../tool-call-reporting';

// This module must stay free of any MCP SDK import (`sdk-free-entries.test.ts` checks it), so a Worker that serves MCP
// with its own handler, or none, installs no SDK to use `clerkInstrumentHandler`.

/**
 * The part of a Cloudflare Workers `ExecutionContext` this package names. A Worker's own `ExecutionContext` is passed
 * on to the handler as it is.
 */
export type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

/**
 * One Worker request as `clerkInstrumentHandler` received it: the request, and the `env` and `ctx` the Worker's
 * `fetch` was called with. `verifyToken` and a `reporting.ipAddress` function receive it, so they can reach the
 * Worker's bindings.
 */
export type McpFetchRequest<Env = ClerkEnv, Ctx = WorkerExecutionContext> = {
  request: Request;
  env: Env;
  ctx: Ctx;
};

/**
 * What `clerkInstrumentHandler` serves: the handler `createMcpHandler` from MCP SDK 2.x (`@modelcontextprotocol/server`)
 * returns, or a function called for each request that passed the auth check with its `authInfo`, and the Worker's
 * `env` and `ctx`. `authInfo` is `undefined` only for a request without a token that `discoverable` or
 * `publicAccess` let through. Narrow it with `isClerkAuthInfo` before reading Clerk fields such as `extra.userId`.
 */
export type McpHandler<Env = ClerkEnv, Ctx = WorkerExecutionContext> =
  | {
      fetch: (request: Request, options?: { authInfo?: AuthInfo }) => Promise<Response>;
    }
  | ((
      request: Request,
      context: { authInfo: AuthInfo | undefined; env: Env; ctx: Ctx },
    ) => Response | Promise<Response>);

type McpAuthFailureOption = {
  /**
   * Synchronously notifies why the auth check is about to answer a request with a 401 or 403 challenge or a 421, for
   * example for logging. The metadata route's 421, for an origin no listed `resourceUrl` has, is not passed to it.
   * Return values are ignored. Pass asynchronous work to `ctx.waitUntil` to keep it alive after the
   * response; a promise returned here is not awaited.
   */
  onAuthFailure?: ((failure: McpAuthFailure, request: Request) => void) | undefined;
};

/**
 * Options for `clerkInstrumentHandler`. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as
 * its audience, and `clerkClient` defaults to one built with `createClerkClient` from `@clerk/backend`, from
 * `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the Worker `env` passed to `fetch`, with `CLERK_API_URL`,
 * `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set, kept for each set of those settings. `process.env` is
 * never read. With `verifyToken`, that function verifies each token with the `McpFetchRequest`, `resourceUrl` is
 * optional, and `clerkClient` is not allowed. `onAuthFailure` is available either way, and `reporting` turns on MCP
 * activity reporting.
 */
export type McpAuthOptions<Env = ClerkEnv, Ctx = WorkerExecutionContext> = McpAuthFailureOption &
  MiddlewareAuthOptions<McpFetchRequest<Env, Ctx>> &
  ReportingOption<McpFetchRequest<Env, Ctx>>;

const clerkInstrumentHandlerCaller = 'clerkInstrumentHandler from @clerk/mcp-tools/fetch';
const clerkInstrumentHandlerCallForm =
  'clerkInstrumentHandler(handler, { resourceUrl }), or as clerkInstrumentHandler(handler, { verifyToken }) to verify tokens with your own function';

/**
 * Wraps a Worker's MCP handler so that every request needs a valid bearer token, and serves the RFC 9728 protected
 * resource metadata the challenge points to. By default Clerk verifies the OAuth access token, including that its
 * audience is this endpoint; pass `verifyToken` to verify tokens with your own function. It imports no MCP SDK, so
 * the handler can be the one `createMcpHandler` from `@modelcontextprotocol/server` returns, or any `fetch`-style
 * MCP handler.
 *
 * Route both the MCP endpoint and its metadata URL (RFC 9728 section 3.1: `/.well-known/oauth-protected-resource`
 * followed by the endpoint's path and query) to the wrapped handler. A GET or HEAD there gets the metadata, with the
 * publishable key read from the Worker's `CLERK_PUBLISHABLE_KEY`, an OPTIONS the CORS preflight, and another method a
 * 405 with `Cache-Control: no-store`; a request to an origin no listed `resourceUrl` has gets a 421. Any other path or
 * query, such as the bare well-known root, goes through the auth check to the handler. Without `resourceUrl`, any
 * path below the well-known prefix gets the metadata for the resource it describes.
 *
 * With `reporting`, it reports to Clerk the tool calls of each server passed to `clerkInstrumentServer`, and each 401,
 * 403 or 421 from the auth check, with `reporting.secretKey` or else the `CLERK_SECRET_KEY` of the Worker `env`. The
 * reports are sent with `ctx.waitUntil` once the response is over. The metadata route's 421 for an unlisted origin is
 * neither reported nor passed to `onAuthFailure`.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3
 * @see https://datatracker.ietf.org/doc/html/rfc6750#section-3
 * @param handler - The handler `createMcpHandler` from `@modelcontextprotocol/server` returns, or a function called
 * with the request and `{ authInfo, env, ctx }`
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
 * import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
 * import { clerkInstrumentHandler, clerkInstrumentServer } from '@clerk/mcp-tools/fetch';
 *
 * const mcp = createMcpHandler(() => {
 *   const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
 *   clerkInstrumentServer(server);
 *   // register tools
 *   return server;
 * });
 *
 * const authedHandler = clerkInstrumentHandler(mcp, {
 *   resourceUrl: 'https://mcp.example.com/mcp',
 *   requiredScopes: ['profile', 'email'],
 *   reporting: true,
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
export function clerkInstrumentHandler<Env = ClerkEnv, Ctx = WorkerExecutionContext>(
  handler: McpHandler<Env, Ctx>,
  options: McpAuthOptions<Env, Ctx>,
): (request: Request, env: Env, ctx: Ctx) => Promise<Response> {
  if (
    typeof handler !== 'function' &&
    typeof (handler as { fetch?: unknown } | null)?.fetch !== 'function'
  ) {
    throw new Error(
      `Clerk error: ${clerkInstrumentHandlerCaller} takes the MCP handler first: the handler createMcpHandler from @modelcontextprotocol/server returns, or a function of the request and { authInfo, env, ctx }. Call it as ${clerkInstrumentHandlerCallForm}`,
    );
  }
  return fetchInstrumentHandler(handler, options, {
    caller: clerkInstrumentHandlerCaller,
    callForm: clerkInstrumentHandlerCallForm,
    reportingCaller: 'clerkInstrumentHandler',
  });
}

/**
 * `clerkInstrumentHandler` without its handler check, with the entry point its messages name: `createClerkMcpWorker`
 * uses it so a missing key or option names the function the Worker called.
 * @param names.caller - The entry point named in the auth messages, such as
 * `clerkInstrumentHandler from @clerk/mcp-tools/fetch`
 * @param names.callForm - How to call that entry point, for the messages that say so
 * @param names.reportingCaller - The entry point named in the reporting messages, as the other adapters name theirs
 */
export function fetchInstrumentHandler<Env, Ctx>(
  handler: McpHandler<Env, Ctx>,
  options: McpAuthOptions<Env, Ctx>,
  {
    caller,
    callForm,
    reportingCaller,
  }: { caller: string; callForm: string; reportingCaller: string },
): (request: Request, env: Env, ctx: Ctx) => Promise<Response> {
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: ${caller} needs a resourceUrl to verify tokens with Clerk. Call it as ${callForm}`,
  );
  const { reporting: reportingOption, ...authOptions } = options;
  assertMcpAuthOptions(caller, authOptions, new Set(['onAuthFailure']));
  const reporting = resolveReporting<McpFetchRequest<Env, Ctx>>(reportingCaller, reportingOption);

  const authenticate = createBearerAuth(
    caller,
    authOptions,
    // Only the Worker env: Workers have no `process.env` to fall back to, so it is never read
    ({ env }: McpFetchRequest<Env, Ctx>) =>
      envClerkClient(caller, workerKeys(env), 'variable in the Worker env'),
    'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY in the Worker env',
  );

  // Reports a 401, 403 or 421, reading a copy of the body after the answer, and keeps the Worker alive until it is sent
  const reportFailure = (
    fetchRequest: McpFetchRequest<Env, Ctx>,
    keys: ClerkEnv,
    answer: { failure: McpAuthFailure; status: number; authInfo: AuthInfo | undefined },
  ) => {
    if (!reporting) return;
    const { request, ctx } = fetchRequest;
    const report = reportAuthFailure({
      caller: reportingCaller,
      reporting,
      answer,
      // `readJsonBody` takes its copy now, before the answer, and reads it afterwards, so the request is untouched and
      // the answer never waits for the body
      body: readJsonBody(request, undefined, AUTH_FAILURE_BODY_LIMIT),
      request: fetchRequest,
      ...reportFields(request, keys),
      sessionIdHash: hashSessionId(
        keys.CLERK_PUBLISHABLE_KEY,
        request.headers.get('mcp-session-id'),
      ),
    })
      .then((send) => send?.())
      .catch(() => undefined);
    waitUntil(ctx, report);
  };

  const isMetadataRequest = metadataRoute(authOptions.resourceUrl);

  return async (request, env, ctx) => {
    const keys = workerKeys(env);
    if (isMetadataRequest(request.url)) {
      return metadataResponse(authOptions, request, keys.CLERK_PUBLISHABLE_KEY);
    }

    const fetchRequest = { request, env, ctx };
    const result = await authenticate(fetchRequest, {
      authorization: request.headers.get('authorization') ?? undefined,
      requestUrl: request.url,
      method: request.method,
      // A clone, so the handler can still read the request
      body: () => readJsonBody(request),
    });
    if ('serverError' in result) {
      const answer = serverErrorAnswer(result.serverError);
      return Response.json(answer.body, { status: answer.status });
    }
    if (!result.ok) {
      // The notification and the report must not delay the challenge or turn it into a server error
      if (result.failure) {
        try {
          // `void` callback positions still accept async functions. Guard accidentally returned promises and thenables
          void Promise.resolve(authOptions.onAuthFailure?.(result.failure, request)).catch(
            () => {},
          );
        } catch {}
        try {
          reportFailure(fetchRequest, keys, {
            failure: result.failure,
            status: result.status,
            authInfo: result.authInfo,
          });
        } catch {}
      }
      return Response.json(result.body, result);
    }

    const { authInfo } = result;
    const hashing =
      reporting && hashSessionId(keys.CLERK_PUBLISHABLE_KEY, request.headers.get('mcp-session-id'));
    const context = beginToolCallContext({
      caller: reportingCaller,
      reporting,
      authInfo,
      request: fetchRequest,
      ...reportFields(request, keys),
      sessionIdHash: hashing && (await hashing),
    });

    const response =
      typeof handler === 'function'
        ? await handler(request, { authInfo, env, ctx })
        : await handler.fetch(request, { ...(authInfo && { authInfo }) });
    if (!context || !reporting) return response;

    return flushAfterResponse(
      response,
      { caller: reportingCaller, context, reporting, request },
      (work) => waitUntil(ctx, work),
    );
  };
}

// The Clerk keys of a Worker env, which may be missing outside Workers
const workerKeys = (env: unknown) => (env ?? {}) as ClerkEnv;

// The request fields every report of a Worker request shares
const reportFields = (request: Request, keys: ClerkEnv) => ({
  defaultIpAddress: () => workerIpAddress(request),
  userAgent: () => request.headers.get('user-agent'),
  env: { secretKey: keys.CLERK_SECRET_KEY, apiUrl: keys.CLERK_API_URL },
});

// Keeps the Worker running until `work` settles. A `ctx` without `waitUntil`, as outside Workers, leaves the reports
// to the reporter's own timer.
function waitUntil(ctx: unknown, work: Promise<unknown>) {
  try {
    (ctx as Partial<WorkerExecutionContext> | undefined)?.waitUntil?.(work);
  } catch {}
}

/**
 * The client's address where the runtime reports it: `cf-connecting-ip` on Cloudflare Workers, whose requests have
 * `cf`, which Cloudflare sets itself, replacing any value the client sent. Anywhere else no address is sent.
 */
function workerIpAddress(request: Request): string | undefined {
  if (typeof (request as Request & { cf?: unknown }).cf !== 'object') return undefined;
  return request.headers.get('cf-connecting-ip') ?? undefined;
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
