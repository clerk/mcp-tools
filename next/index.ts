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
import {
  type AICatalogHandlerOptions,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type ServerCardHandlerOptions,
  aiCatalogResponder,
  serverCardResponder,
} from '../discovery-response';
import { type ClerkOAuthClient, type McpAuthFailure, metadataCorsHeaders } from '../server';
import {
  type AuthFailureAnswer,
  type ReportingOption,
  AUTH_FAILURE_BODY_LIMIT,
  beginToolCallContext,
  checkToolCallContext,
  onResponseEnd,
  reportAuthFailure,
  reportingKey,
  resolveReporting,
  withoutReporting,
} from '../tool-call-reporting';

export type { AICatalogHandlerOptions, ServerCardHandlerOptions };

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions` of `clerkInstrumentHandler`, all optional,
 * plus `properties`. Reuse the auth options, such as those exported from `lib/mcp.ts`, adding `properties` only for
 * the metadata handler, not `clerkInstrumentHandler`. The handler reads `resourceUrl`, `requiredScopes`,
 * `challengeScopes`, and `properties`, and ignores the other `McpAuthOptions` keys: `clerkClient`, `verifyToken`,
 * `onAuthFailure`, and `reporting`.
 */
export type ProtectedResourceMetadataOptions =
  SharedProtectedResourceMetadataOptions<McpAuthOptions>;

// Everything in the core subpath, so a Next.js app imports from this subpath alone
export * from '../server';

/**
 * A Next.js route handler that serves RFC 9728 protected resource metadata for the Clerk instance named by
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Export it from the route at the path `withClerkMcpAuth`'s challenge points to.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3
 * @param options - See `ProtectedResourceMetadataOptions`
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
  // `onAuthFailure` is the one key of `withClerkMcpAuth`'s options that the Express and Hono `mcpAuth` options do not have
  assertProtectedResourceMetadataOptions(options, new Set(['onAuthFailure', reportingKey]));

  return (req: Request): Response => {
    const answer = protectedResourceMetadataAnswer(options, {
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
  return () => new Response(null, { status: 200, headers: metadataCorsHeaders });
}

/**
 * A Next.js route handler that serves an MCP Server Card, the public document a client reads before it connects to
 * learn what the server is and where to connect. It validates the options and generates the card when it is created,
 * so it needs no Clerk keys or MCP SDK and makes no request, and later changes to the options change nothing.
 * Importing it adds no route.
 *
 * Any origin can read the card. GET and HEAD get it with a weak `ETag` and `Cache-Control: public, max-age=3600`, or
 * `maxAge`'s seconds (`public, no-cache` for `0`), and a matching `If-None-Match` gets a 304 without a body. OPTIONS
 * gets the CORS preflight, another method a 405, and a request to an origin no listed `resourceUrl` has a 421, each
 * error with `Cache-Control: no-store`. Next.js only calls the handler for the methods the route exports, so export it
 * for each of them: without an `OPTIONS` export, Next.js answers the preflight itself, without the CORS headers.
 * @see https://github.com/modelcontextprotocol/ext-server-card
 * @param options - See `ServerCardHandlerOptions`
 * @returns The handler. It throws a `Clerk error:` naming the first option the card cannot have. Exporting
 * `serverCardHandler` itself, without calling it, throws a `Clerk error:` on the first request.
 * @example
 * ```ts
 * // app/mcp/server-card/route.ts
 * const handler = serverCardHandler({
 *   name: 'com.example/weather',
 *   version: '1.2.0',
 *   description: 'Forecasts and current conditions.',
 *   resourceUrl: 'https://mcp.example.com/mcp',
 * });
 *
 * export {
 *   handler as GET,
 *   handler as HEAD,
 *   handler as OPTIONS,
 *   handler as POST,
 *   handler as PUT,
 *   handler as PATCH,
 *   handler as DELETE,
 * };
 * ```
 */
export function serverCardHandler(options: ServerCardHandlerOptions): (req: Request) => Response {
  assertDiscoveryHandlerCalled('serverCardHandler', options);
  return discoveryHandler(serverCardResponder('serverCardHandler', options));
}

/**
 * A Next.js route handler that serves an AI Catalog linking to MCP Server Cards, the document a client reads at
 * `/.well-known/ard.json`, or its predecessor path `/.well-known/ai-catalog.json`, to find a domain's MCP servers. It
 * validates the options and generates the catalog when it is created, so it needs no Clerk keys or MCP SDK and never
 * fetches the cards it links to, and later changes to the options change nothing. The catalog is the same for every
 * request: to answer on several origins with their own cards, create one handler for each and pick it by origin.
 * Importing it adds no route.
 *
 * Any origin can read the catalog, served as `application/ai-catalog+json`. GET and HEAD get it with a weak `ETag` and
 * `Cache-Control: public, max-age=3600`, or `maxAge`'s seconds (`public, no-cache` for `0`), and a matching
 * `If-None-Match` gets a 304 without a body. OPTIONS gets the CORS preflight, and another method a 405 with
 * `Cache-Control: no-store`. Export it for each method, as for `serverCardHandler`, from the `ard.json` route, and
 * re-export that route's methods from the `ai-catalog.json` route, so both paths get the same body and headers.
 * @see https://github.com/Agent-Card/ai-catalog
 * @see https://agenticresourcediscovery.org/spec/#51-discovery-mechanisms
 * @param options - See `AICatalogHandlerOptions`
 * @returns The handler. It throws a `Clerk error:` naming the first option the catalog cannot have. Exporting
 * `aiCatalogHandler` itself, without calling it, throws a `Clerk error:` on the first request.
 * @example
 * ```ts
 * // app/.well-known/ard.json/route.ts
 * const handler = aiCatalogHandler({
 *   entries: [
 *     {
 *       identifier: 'urn:air:example.com:weather',
 *       displayName: 'Weather',
 *       url: 'https://mcp.example.com/mcp/server-card',
 *     },
 *   ],
 * });
 *
 * export {
 *   handler as GET,
 *   handler as HEAD,
 *   handler as OPTIONS,
 *   handler as POST,
 *   handler as PUT,
 *   handler as PATCH,
 *   handler as DELETE,
 * };
 *
 * // app/.well-known/ai-catalog.json/route.ts
 * export { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } from '../ard.json/route';
 * ```
 */
export function aiCatalogHandler(options: AICatalogHandlerOptions): (req: Request) => Response {
  assertDiscoveryHandlerCalled('aiCatalogHandler', options);
  return discoveryHandler(aiCatalogResponder('aiCatalogHandler', options));
}

// Exported uncalled as a method, the factory is called with the request, which would otherwise fail on a missing option
function assertDiscoveryHandlerCalled(caller: string, options: unknown) {
  if (options instanceof Request) {
    throw new Error(
      `Clerk error: call ${caller}(options) and export its result from the route, instead of exporting ${caller} itself`,
    );
  }
}

function discoveryHandler(respond: (request: DiscoveryRequest) => DiscoveryAnswer) {
  // The request's own URL selects a listed resourceUrl, as for `protectedResourceMetadataHandler`; Host and
  // X-Forwarded-* are never read. The serialized body is sent as it is, so it is the one the ETag was computed from.
  return (req: Request): Response => {
    const answer = respond({
      method: req.method,
      url: req.url,
      ifMatch: req.headers.get('if-match'),
      ifNoneMatch: req.headers.get('if-none-match'),
    });
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
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
 * Options for `clerkInstrumentHandler`. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as
 * its audience, and `clerkClient` defaults to `clerkClient` from `@clerk/nextjs/server`, loaded on the first request,
 * which needs `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` set. An app that passes its keys to
 * `clerkMiddleware()` instead, or runs in keyless mode, passes `clerkClient: () => clerkClient()` from
 * `@clerk/nextjs/server`, with the MCP route in the middleware's matcher. With `verifyToken`, that function verifies
 * each token with the request, `resourceUrl` is optional, and `clerkClient` is not allowed. `onAuthFailure` is
 * available either way. `reporting` turns on tool call reporting. The deprecated `withClerkMcpAuth` takes the
 * same options without it.
 */
export type McpAuthOptions = McpAuthFailureOption &
  MiddlewareAuthOptions<Request> &
  ReportingOption<Request>;

/**
 * What `clerkInstrumentHandler` serves: the route handler `createMcpHandler` from `mcp-handler` returns, which reads
 * the auth info from `req.auth`, the handler `createMcpHandler` from MCP SDK 2.x (`@modelcontextprotocol/server`)
 * returns, or any function that serves a request with its auth info.
 */
export type McpHandler =
  | {
      fetch: (request: Request, options?: { authInfo?: AuthInfo }) => Promise<Response>;
    }
  | ((req: Request, options: { authInfo: AuthInfo | undefined }) => Response | Promise<Response>);

const withClerkMcpAuthCallForm =
  'withClerkMcpAuth(handler, { resourceUrl }), or as withClerkMcpAuth(handler, { verifyToken }) to verify tokens with your own function';

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
 * import { withClerkMcpAuth } from "@clerk/mcp-tools/next";
 *
 * const authedHandler = withClerkMcpAuth(handler, {
 *   resourceUrl: "https://mcp.example.com/mcp",
 *   requiredScopes: ["profile", "email"],
 * });
 *
 * export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
 * ```
 * @example
 * ```ts
 * // Verify tokens with your own function instead of Clerk
 * const authedHandler = withClerkMcpAuth(handler, {
 *   verifyToken: async (token, req) => verifyMyToken(token),
 *   resourceUrl: "https://mcp.example.com/mcp",
 * });
 * ```
 * @deprecated Use `clerkInstrumentHandler(handler, options)`, which authenticates the same way and can report tool calls
 */
export function withClerkMcpAuth(
  handler: McpRouteHandler,
  options: McpAuthFailureOption & MiddlewareAuthOptions<Request>,
): (req: Request) => Promise<Response> {
  if (typeof handler !== 'function') {
    throw new Error(
      `Clerk error: withClerkMcpAuth from @clerk/mcp-tools/next takes the route handler first. Call it as ${withClerkMcpAuthCallForm}`,
    );
  }
  options = withoutReporting('withClerkMcpAuth', options);
  // `mcp-handler`'s `withMcpAuth` takes a verifier function here, so code moved from it fails at startup
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: withClerkMcpAuth from @clerk/mcp-tools/next needs a resourceUrl to verify tokens with Clerk. Call it as ${withClerkMcpAuthCallForm}`,
  );
  assertMcpAuthOptions('withClerkMcpAuth', options, new Set(['onAuthFailure']));
  const authenticate = nextAuthenticator(
    'withClerkMcpAuth from @clerk/mcp-tools/next',
    'withClerkMcpAuth',
    options,
  );

  return async (req) => {
    const authenticated = await authenticate(req);
    return authenticated instanceof Response ? authenticated : handler(req);
  };
}

/**
 * Verifies the request's token as `withClerkMcpAuth` does.
 * @param onFailure - Called with a 401, 403 or 421 before it is answered, for reporting
 * @returns The answer for a request that is not let through, or the auth info of one that is, also set on `req.auth`:
 * `undefined` for a request without a token that `publicAccess` let through
 */
function nextAuthenticator(
  caller: string,
  shortName: string,
  options: McpAuthFailureOption & MiddlewareAuthOptions<Request>,
  onFailure?: (req: Request, answer: AuthFailureAnswer) => Promise<void>,
) {
  const authenticate = createBearerAuth(
    caller,
    options,
    nextClerkClient(shortName),
    "clerkClient from '@clerk/nextjs/server'",
  );

  return async (req: Request): Promise<Response | { authInfo: AuthInfo | undefined }> => {
    const result = await authenticate(req, {
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
        // Reporting must never change or fail the answer
        try {
          await onFailure?.(req, {
            failure: result.failure,
            status: result.status,
            authInfo: result.authInfo,
          });
        } catch {}
      }
      return Response.json(result.body, result);
    }

    // `mcp-handler` passes `req.auth` to its transport, as its own `withMcpAuth` does. It is `undefined` for a
    // request without a token that `publicAccess` let through.
    (req as Request & { auth?: AuthInfo }).auth = result.authInfo;
    return { authInfo: result.authInfo };
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
function nextClerkClient(caller: string) {
  return async (): Promise<ClerkOAuthClient> => {
    let nextjs: typeof import('@clerk/nextjs/server');
    try {
      nextjs = await import('@clerk/nextjs/server');
    } catch (error) {
      throw new Error(`Clerk error: install @clerk/nextjs, or pass clerkClient to ${caller}`, {
        cause: error,
      });
    }
    // `@clerk/backend` checks the keys only when a token is verified, and a missing one would then look like a Clerk
    // outage once the client has authorized, so they are checked here as the Express and Hono adapters check theirs.
    // Each is written out, not looked up by name: Next.js inlines `process.env.NEXT_PUBLIC_*` only where it is written
    // out, so a publishable key set only at build time is missing from `process.env[name]` at run time.
    requireClerkEnvKeys(caller, {
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    });
    return nextjs.clerkClient();
  };
}

const clerkInstrumentHandlerCallForm =
  'clerkInstrumentHandler(handler, { resourceUrl }), or as clerkInstrumentHandler(handler, { verifyToken }) to verify tokens with your own function';

/**
 * Wraps an MCP route handler so each request is authenticated as `withClerkMcpAuth` does before `handler` serves it.
 * A missing or rejected token gets a 401 challenge, a token without `requiredScopes` a 403 challenge, and a request
 * to an origin no `resourceUrl` lists a 421, and `onAuthFailure` is told why. A request it lets through reaches
 * `handler` with its auth info, also set on `req.auth`, where `mcp-handler` reads it. Tools read it as
 * `ctx.http?.authInfo`.
 *
 * With `reporting`, it reports to Clerk the tool calls of each server passed to `clerkInstrumentServer`, and each 401,
 * 403 or 421 it answers, with `CLERK_SECRET_KEY`. The reports are sent with `after()` from `next/server` once the
 * response is over, so serverless functions keep running until they are sent.
 * @param handler - The route handler `createMcpHandler` from `mcp-handler` returns, the handler `createMcpHandler` from
 * `@modelcontextprotocol/server` returns, or a function of the request and its auth info
 * @param options - See `McpAuthOptions`. `clerkClient` defaults to `clerkClient` from `@clerk/nextjs/server`.
 * @returns The route handler, to export as `GET`, `POST`, and `DELETE`
 * @example
 * ```ts
 * // app/mcp/route.ts
 * import { createMcpHandler } from 'mcp-handler';
 * import { clerkInstrumentHandler, clerkInstrumentServer } from '@clerk/mcp-tools/next';
 *
 * const handler = createMcpHandler(
 *   (server) => {
 *     clerkInstrumentServer(server);
 *     // register tools
 *   },
 *   { serverInfo: { name: 'acme-mcp', version: '1.0.0' } },
 * );
 *
 * const authedHandler = clerkInstrumentHandler(handler, {
 *   resourceUrl: 'https://mcp.example.com/mcp',
 *   requiredScopes: ['profile', 'email'],
 *   reporting: true,
 * });
 *
 * export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
 * ```
 */
export function clerkInstrumentHandler(
  handler: McpHandler,
  options: McpAuthOptions,
): (req: Request) => Promise<Response> {
  if (
    typeof handler !== 'function' &&
    typeof (handler as { fetch?: unknown } | null)?.fetch !== 'function'
  ) {
    throw new Error(
      `Clerk error: clerkInstrumentHandler from @clerk/mcp-tools/next takes the route handler first. Call it as ${clerkInstrumentHandlerCallForm}`,
    );
  }
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: clerkInstrumentHandler from @clerk/mcp-tools/next needs a resourceUrl to verify tokens with Clerk. Call it as ${clerkInstrumentHandlerCallForm}`,
  );
  const { reporting: reportingOption, ...authOptions } = options;
  assertMcpAuthOptions('clerkInstrumentHandler', authOptions, new Set(['onAuthFailure']));
  const reporting = resolveReporting<Request>('clerkInstrumentHandler', reportingOption);
  const authenticate = nextAuthenticator(
    'clerkInstrumentHandler from @clerk/mcp-tools/next',
    'clerkInstrumentHandler',
    authOptions,
    reporting &&
      (async (req, answer) => {
        const send = await reportAuthFailure({
          caller: 'clerkInstrumentHandler',
          reporting,
          answer,
          // A copy, and only with reporting on, so the route handler's request is untouched
          readBody: () => readJsonBody(req, undefined, AUTH_FAILURE_BODY_LIMIT),
          request: req,
          defaultIpAddress: () => (process.env.VERCEL ? req.headers.get('x-real-ip') : undefined),
          userAgent: () => req.headers.get('user-agent'),
          env: { secretKey: process.env.CLERK_SECRET_KEY, apiUrl: process.env.CLERK_API_URL },
        });
        if (send) await keepAlive(send());
      }),
  );

  return async (req) => {
    const authenticated = await authenticate(req);
    if (authenticated instanceof Response) return authenticated;
    const { authInfo } = authenticated;

    const context = beginToolCallContext({
      caller: 'clerkInstrumentHandler',
      reporting,
      authInfo,
      request: req,
      // Vercel sets `x-real-ip` itself, replacing any value the client sent
      defaultIpAddress: () => (process.env.VERCEL ? req.headers.get('x-real-ip') : undefined),
      userAgent: () => req.headers.get('user-agent'),
      env: { secretKey: process.env.CLERK_SECRET_KEY, apiUrl: process.env.CLERK_API_URL },
    });

    const response =
      typeof handler === 'function'
        ? await handler(req, { authInfo })
        : await handler.fetch(req, { ...(authInfo && { authInfo }) });
    if (!context || !reporting) return response;

    let ended!: () => void;
    const end = new Promise<void>((resolve) => (ended = resolve));
    await keepAlive(end.then(() => context.flush()));
    return onResponseEnd(response, () => {
      checkToolCallContext('clerkInstrumentHandler', context, reporting, {
        method: req.method,
        status: response.status,
        mcpMethod: req.headers.get('mcp-method'),
      });
      ended();
    });
  };
}

let nextServer: Promise<typeof import('next/server') | undefined> | undefined;

/**
 * Keeps the function running until `work` settles, with `after()` from `next/server`. Outside a Next.js request, such
 * as in tests, `after()` throws and the reporter's own timer sends the reports instead.
 */
async function keepAlive(work: Promise<unknown>) {
  nextServer ??= import('next/server').catch(() => undefined);
  try {
    (await nextServer)?.after(work);
  } catch {}
}
