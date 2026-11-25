import type { AuthInfo, McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMcpAuthOptions,
  assertMiddlewareAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertStreamableHttpArgs,
  assertVerifierOrResourceUrl,
  authorizationServerMetadataAnswer,
  createBearerAuth,
  methodNotAllowed,
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
import {
  type ClerkOAuthClient,
  type McpAuthError,
  type McpAuthFailure,
  metadataCorsHeaders,
} from '../server';

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * The auth info of the request's verified token, or `undefined` for a request without a token that
     * `publicAccess` let through.
     */
    mcpAuth: AuthInfo | undefined;
    /**
     * Why `mcpAuth` answered this request with a 401 or 403 challenge or a 421, when it did.
     */
    mcpAuthFailure: McpAuthFailure | undefined;
  }
}

// Everything in the core subpath, so a Hono app imports from this subpath alone
export * from '../server';

export type { AICatalogHandlerOptions, ServerCardHandlerOptions };

/**
 * Options for `clerkInstrumentHandler`. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as
 * its audience, and `clerkClient` defaults to one built from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the
 * app's environment. With `verifyToken`, that function verifies each token with the Hono context, `resourceUrl` is
 * optional, and `clerkClient` is not allowed. `reporting` turns on MCP activity reporting. The deprecated `mcpAuth`
 * takes the same options without it.
 */
export type McpAuthOptions = MiddlewareAuthOptions<Context> & ReportingOption<Context>;

/**
 * What `clerkInstrumentHandler` serves: the handler `createMcpHandler` from MCP SDK 2.x (`@modelcontextprotocol/server`)
 * returns, or a function that serves a web-standard request with the auth info, such as one that passes both to the
 * `handleRequest` of MCP SDK 1.x's `WebStandardStreamableHTTPServerTransport`.
 */
export type McpHandler =
  | {
      fetch: (request: Request, options?: { authInfo?: AuthInfo }) => Promise<Response>;
    }
  | ((
      request: Request,
      options: { authInfo: AuthInfo | undefined },
    ) => Response | Promise<Response>);

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions`, all optional, plus `properties`. Reuse the
 * auth options here, adding `properties` only for the metadata handler, not `mcpAuth`. The handler reads
 * `resourceUrl`, `requiredScopes`, `challengeScopes`, and `properties`, and
 * ignores the other `McpAuthOptions` keys: `clerkClient`, `verifyToken`, and `reporting`.
 */
export type ProtectedResourceMetadataOptions =
  SharedProtectedResourceMetadataOptions<McpAuthOptions>;

/**
 * The part of a web-standard streamable HTTP server transport, such as `WebStandardStreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, that `streamableHttpHandler` uses.
 */
interface WebStandardStreamableHttpTransport {
  /**
   * Handles one MCP request, with the auth info of its verified token, if any, and returns the response.
   */
  handleRequest(request: Request, options: { authInfo: AuthInfo | undefined }): Promise<Response>;
  /**
   * Closes the transport.
   */
  close(): Promise<void>;
}

type ClerkEnv = {
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_API_URL?: string;
  CLERK_API_VERSION?: string;
  CLERK_JWT_KEY?: string;
};

// The clients `mcpAuth` built from the environment, keyed by every setting, the secret included (in memory only). On
// Cloudflare Workers the settings are only known per request, on `c.env`, so the client can't be built at setup.
const envClerkClients = new Map<string, ClerkOAuthClient>();

/**
 * The settings a Clerk client is built from, read from the app's environment through `env(c)`: the secret and
 * publishable keys, and `CLERK_API_URL`, `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set, as
 * `clerkClient` from `@clerk/express` reads them.
 * @param c - The Hono context of the request
 * @returns The settings, without the optional ones that are not set. It throws a `Clerk error:` naming the first key
 * not set.
 */
function requireClerkKeys(c: Context, caller: string) {
  const {
    CLERK_SECRET_KEY,
    CLERK_PUBLISHABLE_KEY,
    CLERK_API_URL,
    CLERK_API_VERSION,
    CLERK_JWT_KEY,
  } = env<ClerkEnv>(c);
  const keys = requireClerkEnvKeys(caller, { CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY });
  // Only the ones that are set, so `createClerkClient` keeps its own defaults for the others
  return {
    secretKey: keys.CLERK_SECRET_KEY,
    publishableKey: keys.CLERK_PUBLISHABLE_KEY,
    ...(CLERK_API_URL && { apiUrl: CLERK_API_URL }),
    ...(CLERK_API_VERSION && { apiVersion: CLERK_API_VERSION }),
    ...(CLERK_JWT_KEY && { jwtKey: CLERK_JWT_KEY }),
  };
}

/**
 * The Clerk client built from the environment's keys, loading `@clerk/backend` the first time. The package is an
 * optional peer that only this path needs, so it is loaded with `import()` inside `try`: a bundler such as esbuild
 * fails the build on a bare `import()` of a missing package, but not on one inside `try`.
 * @param keys - The settings `requireClerkKeys` read
 * @returns The client, the same one for the same settings
 */
async function envClerkClient(keys: ReturnType<typeof requireClerkKeys>, caller: string) {
  // `requireClerkKeys` builds the settings in one key order and leaves out the ones not set, so each set of settings
  // has one cache key
  const cacheKey = JSON.stringify(keys);
  const cached = envClerkClients.get(cacheKey);
  if (cached) return cached;

  let backend: typeof import('@clerk/backend');
  try {
    backend = await import('@clerk/backend');
  } catch (error) {
    throw new Error(`Clerk error: install @clerk/backend, or pass clerkClient to ${caller}`, {
      cause: error,
    });
  }

  const client = backend.createClerkClient(keys);
  envClerkClients.set(cacheKey, client);
  return client;
}

/**
 * A Hono handler that serves RFC 9728 protected resource metadata for a Clerk instance, using the publishable key in
 * the `CLERK_PUBLISHABLE_KEY` environment variable. Mount it at the path `mcpAuth`'s challenge points to.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3
 * @param options - See `ProtectedResourceMetadataOptions`
 * @returns The handler. A request to an origin no listed `resourceUrl` has gets a 421. It throws when
 * `CLERK_PUBLISHABLE_KEY` is not set.
 * @example
 * ```ts
 * app.get(
 *   '/.well-known/oauth-protected-resource/mcp',
 *   protectedResourceMetadataHandler({ resourceUrl: 'https://mcp.example.com/mcp' }),
 * );
 * ```
 */
export function protectedResourceMetadataHandler(options: ProtectedResourceMetadataOptions = {}) {
  assertProtectedResourceMetadataOptions(options, new Set([reportingKey]));

  return (c: Context) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 200, metadataCorsHeaders);
    // Hono always has a URL, so there is no 400
    const answer = protectedResourceMetadataAnswer(options, {
      publishableKey: env<ClerkEnv>(c).CLERK_PUBLISHABLE_KEY,
      url: c.req.url,
    });
    return c.json(answer.body as Record<string, unknown>, {
      status: answer.status as 200 | 421,
      headers: answer.headers,
    });
  };
}

/**
 * A Hono handler that serves the RFC 8414 authorization server metadata of the Clerk instance named by
 * `CLERK_PUBLISHABLE_KEY`, fetched from its Frontend API on each request.
 * @see https://datatracker.ietf.org/doc/html/rfc8414#section-3
 * @returns The handler. It throws when `CLERK_PUBLISHABLE_KEY` is not set. Passing
 * `authorizationServerMetadataHandler` to the route without calling it throws a `Clerk error:` on the first request.
 * @example
 * ```ts
 * app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
 * ```
 */
export function authorizationServerMetadataHandler() {
  assertAuthorizationServerMetadataHandlerCalled(arguments.length);
  return async (c: Context) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 200, metadataCorsHeaders);
    const answer = await authorizationServerMetadataAnswer({
      publishableKey: env<ClerkEnv>(c).CLERK_PUBLISHABLE_KEY,
    });
    return c.json(answer.body, { status: answer.status as 200 | 502, headers: answer.headers });
  };
}

/**
 * A Hono handler that serves an MCP Server Card, the public document a client reads before it connects to learn what
 * the server is and where to connect. It validates the options and generates the card when it is created, so it
 * needs no Clerk keys or MCP SDK and makes no request, and later changes to the options change nothing. Mount it with
 * `app.all` so OPTIONS and other methods reach it; importing it mounts nothing.
 *
 * Any origin can read the card. GET and HEAD get it with a weak `ETag` and `Cache-Control: public, max-age=3600`, or
 * `maxAge`'s seconds (`public, no-cache` for `0`), and a matching `If-None-Match` gets a 304 without a body.
 * OPTIONS gets the CORS preflight, another method a 405, and a request to an origin no listed `resourceUrl` has a
 * 421, each error with `Cache-Control: no-store`.
 * @see https://github.com/modelcontextprotocol/ext-server-card
 * @param options - See `ServerCardHandlerOptions`
 * @returns The handler. It throws a `Clerk error:` naming the first option the card cannot have.
 * @example
 * ```ts
 * app.all(
 *   '/mcp/server-card',
 *   serverCardHandler({
 *     name: 'com.example/weather',
 *     version: '1.2.0',
 *     description: 'Forecasts and current conditions.',
 *     resourceUrl: 'https://mcp.example.com/mcp',
 *   }),
 * );
 * ```
 */
export function serverCardHandler(options: ServerCardHandlerOptions) {
  return discoveryHandler(serverCardResponder('serverCardHandler', options));
}

/**
 * A Hono handler that serves an AI Catalog linking to MCP Server Cards, the document a client reads at
 * `/.well-known/ard.json`, or its predecessor path `/.well-known/ai-catalog.json`, to find a domain's MCP servers. It
 * validates the options and generates the catalog when it is created, so it needs no Clerk keys or MCP SDK and never
 * fetches the cards it links to, and later changes to the options change nothing. The catalog is the same for every
 * request: to answer on several origins with their own cards, create one handler for each and pick it by origin. Mount
 * the one handler at both paths with `app.all` so OPTIONS and other methods reach it; importing it mounts nothing.
 *
 * Any origin can read the catalog, served as `application/ai-catalog+json`. GET and HEAD get it with a weak `ETag` and
 * `Cache-Control: public, max-age=3600`, or `maxAge`'s seconds (`public, no-cache` for `0`), and a matching
 * `If-None-Match` gets a 304 without a body. OPTIONS gets the CORS preflight, and another method a 405 with
 * `Cache-Control: no-store`. Both paths get the same body and headers.
 * @see https://github.com/Agent-Card/ai-catalog
 * @see https://agenticresourcediscovery.org/spec/#51-discovery-mechanisms
 * @param options - See `AICatalogHandlerOptions`
 * @returns The handler. It throws a `Clerk error:` naming the first option the catalog cannot have.
 * @example
 * ```ts
 * const catalog = aiCatalogHandler({
 *   entries: [
 *     {
 *       identifier: 'urn:air:example.com:weather',
 *       displayName: 'Weather',
 *       url: 'https://mcp.example.com/mcp/server-card',
 *     },
 *   ],
 * });
 *
 * app.all('/.well-known/ard.json', catalog);
 * app.all('/.well-known/ai-catalog.json', catalog);
 * ```
 */
export function aiCatalogHandler(options: AICatalogHandlerOptions) {
  return discoveryHandler(aiCatalogResponder('aiCatalogHandler', options));
}

function discoveryHandler(respond: (request: DiscoveryRequest) => DiscoveryAnswer) {
  return (c: Context) => {
    const answer = respond({
      method: c.req.method,
      url: c.req.url,
      ifMatch: c.req.header('if-match'),
      ifNoneMatch: c.req.header('if-none-match'),
    });
    const exposeHeaders = c.res.headers.get('access-control-expose-headers');
    if (exposeHeaders !== null) {
      const exposed = exposeHeaders.split(',').map((header) => header.trim());
      if (!exposed.includes('*') && !exposed.some((header) => header.toLowerCase() === 'etag')) {
        c.res.headers.set('access-control-expose-headers', [...exposed, 'ETag'].join(', '));
      }
    }
    // Headers already on `c.res` win over those given to `c.body`, so the validator and cache policy are set there:
    // an earlier ETag would advertise a tag the conditional requests were not evaluated against
    if (answer.headers.ETag === undefined) c.res.headers.delete('etag');
    else c.res.headers.set('etag', answer.headers.ETag);
    const cacheControl = answer.headers['Cache-Control'];
    if (cacheControl !== undefined) c.res.headers.set('cache-control', cacheControl);
    // An earlier length would misframe the body, so only a HEAD answer's own, the GET's, is sent; the runtime measures
    // any body
    const contentLength = answer.headers['Content-Length'];
    if (contentLength === undefined) c.res.headers.delete('content-length');
    else c.res.headers.set('content-length', contentLength);
    // `c.body`, not `c.json` or a new Response, keeps the media type and the other headers earlier middleware set
    if (answer.body === null) return c.body(null, answer.status, answer.headers);
    return c.body(answer.body, answer.status as 200 | 400 | 405 | 412 | 421, answer.headers);
  };
}

/**
 * Gives an `McpAuthError` the `getResponse()` that Hono's default error handler answers with for any error that has
 * one, so a request whose token could not be verified at all gets a JSON server error instead of `Internal Server
 * Error` text. A custom `app.onError` still receives the `McpAuthError` and can return `err.getResponse()`. That
 * handler logs only errors without `getResponse()`, so `getResponse()` logs the error with `console.error` itself, and
 * an outage stays as visible as it was.
 */
function withJsonResponse(error: McpAuthError): McpAuthError & { getResponse(): Response } {
  return Object.assign(error, {
    getResponse() {
      const answer = serverErrorAnswer(error);
      return Response.json(answer.body, { status: answer.status });
    },
  });
}

/**
 * Hono middleware that enforces authentication for MCP requests. By default it verifies the OAuth access token with
 * Clerk, including that its audience is this endpoint; pass `verifyToken` to verify tokens with your own function.
 * @param options - See `McpAuthOptions`. Without `clerkClient`, it builds one with `createClerkClient` from
 * `@clerk/backend`, from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` read through `env(c)`, with `CLERK_API_URL`,
 * `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set, kept for each set of those settings. Keep
 * `clerkMiddleware()` off the MCP route, which otherwise verifies each token a second time.
 * @returns The middleware. A missing or rejected token gets a 401 challenge, a token without `requiredScopes` gets a
 * 403 challenge, and a request to an origin no `resourceUrl` lists gets a 421. The reason is recorded in the
 * `mcpAuthFailure` context variable. Without a Clerk client, it throws a `Clerk error:` naming a missing key, or
 * asking to install `@clerk/backend` when it can't be loaded.
 * @example
 * ```ts
 * // Every method, so a GET without a token gets the 401 (or the 405 with publicAccess) rather than a 404
 * app.all(
 *   '/mcp',
 *   mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp', requiredScopes: ['profile', 'email'] }),
 *   streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
 * );
 * ```
 * @example
 * ```ts
 * app.all(
 *   '/mcp',
 *   mcpAuth({ verifyToken: (token, c) => verifyMyToken(token), resourceUrl: 'https://mcp.example.com/mcp' }),
 *   streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
 * );
 * ```
 */
export function mcpAuth(options: MiddlewareAuthOptions<Context>): MiddlewareHandler {
  options = withoutReporting('mcpAuth', options);
  assertMiddlewareAuthOptions(options);
  const authenticate = honoAuthenticator('mcpAuth', options);

  return async (c: Context, next: Next) => {
    const authenticated = await authenticate(c);
    if (authenticated instanceof Response) return authenticated;
    await next();
  };
}

/**
 * Verifies the request's token as `mcpAuth` does.
 * @param onFailure - Called with a 401, 403 or 421 as it is answered, for reporting. It must not wait for anything.
 * @returns The answer for a request that is not let through, or the auth info of one that is, also set as the
 * `mcpAuth` context variable: `undefined` for a request without a token that `publicAccess` let through
 */
function honoAuthenticator(
  caller: string,
  options: MiddlewareAuthOptions<Context>,
  onFailure?: (c: Context, answer: AuthFailureAnswer) => void,
) {
  const authenticate = createBearerAuth(
    caller,
    options,
    (c: Context) => envClerkClient(requireClerkKeys(c, caller), caller),
    'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY',
  );

  return async (c: Context): Promise<Response | { authInfo: AuthInfo | undefined }> => {
    const result = await authenticate(c, {
      authorization: c.req.header('authorization'),
      requestUrl: c.req.url,
      method: c.req.method,
      // A clone, so the MCP transport can still read the request
      body: async () =>
        readJsonBody(
          await requestWithBody(c),
          `Clerk warning: ${caller} could not read the JSON body of a request without a token, because something before it already read c.req.raw, so discoverable and publicAccess open nothing and the request got the 401 challenge. Read the body through Hono, as c.req.json(), or read a copy, as c.req.raw.clone().json(), or set discoverable: false to require a token for every request`,
        ),
    });
    if ('serverError' in result) throw withJsonResponse(result.serverError);
    if (!result.ok) {
      if (result.failure) {
        c.set('mcpAuthFailure', result.failure);
        // Reporting must never change, fail or delay the answer
        try {
          onFailure?.(c, {
            failure: result.failure,
            status: result.status,
            authInfo: result.authInfo,
          });
        } catch {}
      }
      return c.json(result.body, { status: result.status, headers: result.headers });
    }

    c.set('mcpAuth', result.authInfo);
    return { authInfo: result.authInfo };
  };
}

// The requests `requestWithBody` rebuilt, so `mcpAuth` and `streamableHttpHandler` share one copy of the body
const rebuiltRequests = new WeakMap<Context, Promise<Request>>();

/**
 * The readable request for `publicAccess` and the transport. Middleware that reads the body through the Hono
 * request, as `c.req.json()`, leaves the raw request unreadable, but Hono keeps what it read, so the request is
 * rebuilt around that while preserving its other properties, once for each request.
 * @param c - The Hono context of the request
 * @returns The raw request, or a copy of it with the body Hono kept when the raw one was already read
 */
function requestWithBody(c: Context): Promise<Request> {
  const { raw, bodyCache } = c.req;
  if (!raw.bodyUsed || Object.keys(bodyCache).length === 0) return Promise.resolve(raw);
  const rebuilt =
    rebuiltRequests.get(c) ??
    // From the URL and each field, as Hono's own `cloneRawRequest` does, not `new Request(raw, ...)`: on Node,
    // @hono/node-server's lightweight request is not a native `Request`, and with `overrideGlobalObjects: false` the
    // global `Request` reads it as a URL string and throws
    c.req.text().then(
      (body) =>
        new Request(raw.url, {
          method: raw.method,
          headers: raw.headers,
          body,
          cache: raw.cache,
          credentials: raw.credentials,
          integrity: raw.integrity,
          keepalive: raw.keepalive,
          mode: raw.mode,
          redirect: raw.redirect,
          referrer: raw.referrer,
          referrerPolicy: raw.referrerPolicy,
          signal: raw.signal,
        }),
    );
  rebuiltRequests.set(c, rebuilt);
  return rebuilt;
}

/**
 * A Hono handler that serves MCP requests over the streamable HTTP transport, creating a fresh server and transport
 * for each request so that concurrent requests don't share state. It passes on the auth info that `mcpAuth` set.
 * @param createServer - A factory that returns a new MCP server, such as `McpServer` from the MCP SDK, on every
 * call. Passing a server object instead throws when the handler is created.
 * @param Transport - The SDK's web-standard transport class, `WebStandardStreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`. It is taken as an argument so that this package
 * never imports the SDK, which only apps serving MCP with this handler need to install.
 * @returns The handler
 * @example
 * ```ts
 * import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
 *
 * // A request that isn't a POST gets a 405 with `Allow: POST`: the server is stateless
 * app.all(
 *   '/mcp',
 *   mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp' }),
 *   streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
 * );
 * ```
 * @typeParam Transport - The transport the class creates, inferred from the class alone
 * @typeParam Server - The server `createServer` returns. It is a separate type parameter so that `Transport` is not
 * inferred from the SDK's general `Transport` interface, which `McpServer.connect` takes.
 * @deprecated Use `clerkInstrumentHandler(handler, options)` with the handler `createMcpHandler` from MCP SDK 2.x returns
 */
export function streamableHttpHandler<
  Transport extends WebStandardStreamableHttpTransport,
  Server extends McpServerLike<Transport>,
>(createServer: () => Server, Transport: StreamableHttpTransportClass<Transport>) {
  assertStreamableHttpArgs(
    createServer,
    Transport,
    'WebStandardStreamableHTTPServerTransport',
    'webStandardStreamableHttp.js',
  );

  return async (c: Context) => {
    if (c.req.method !== 'POST') {
      return c.json(methodNotAllowed.body, {
        status: methodNotAllowed.status,
        headers: methodNotAllowed.headers,
      });
    }

    const transport = new Transport({ sessionIdGenerator: undefined });

    try {
      const server = createServer();
      await server.connect(transport);
      const response = await transport.handleRequest(await requestWithBody(c), {
        authInfo: c.get('mcpAuth'),
      });

      if (!response.body) {
        await transport.close();
        return response;
      }

      const { readable, writable } = new TransformStream();
      void response.body
        .pipeTo(writable)
        .finally(() => transport.close())
        .catch(() => undefined);

      return new Response(readable, { status: response.status, headers: response.headers });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  };
}

/**
 * A Hono handler that authenticates each MCP request as `mcpAuth` does, then serves it with `handler`. It answers a
 * missing or rejected token with a 401 challenge, a token without `requiredScopes` with a 403 challenge, and a request
 * to an origin no `resourceUrl` lists with a 421, recording the reason in the `mcpAuthFailure` context variable. A
 * request it lets through reaches `handler` with its auth info, which is also the `mcpAuth` context variable.
 *
 * With `reporting`, it reports to Clerk the tool calls of each server passed to `clerkInstrumentServer`, and each 401,
 * 403 or 421 it answers, with the `CLERK_SECRET_KEY` the app's environment has. On Cloudflare Workers the reports are
 * sent with `waitUntil` once the response is over; elsewhere they are sent in batches, about a second after a call or
 * once 100 are waiting.
 * @param handler - The handler `createMcpHandler` from `@modelcontextprotocol/server` returns, or a function that
 * serves a web-standard request with the auth info
 * @param options - See `McpAuthOptions`. Without `clerkClient`, it builds one with `createClerkClient` from
 * `@clerk/backend`, from the keys in the app's environment, as `mcpAuth` does.
 * @returns The Hono handler. Mount it with `app.all`.
 * @example
 * ```ts
 * import { Hono } from 'hono';
 * import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
 * import { clerkInstrumentHandler, clerkInstrumentServer } from '@clerk/mcp-tools/hono';
 *
 * const mcp = createMcpHandler(() => {
 *   const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
 *   clerkInstrumentServer(server);
 *   // register tools
 *   return server;
 * });
 *
 * const app = new Hono();
 * app.all(
 *   '/mcp',
 *   clerkInstrumentHandler(mcp, {
 *     resourceUrl: 'https://mcp.example.com/mcp',
 *     requiredScopes: ['profile', 'email'],
 *     reporting: true,
 *   }),
 * );
 * export default app;
 * ```
 */
export function clerkInstrumentHandler(handler: McpHandler, options: McpAuthOptions) {
  if (
    typeof handler !== 'function' &&
    typeof (handler as { fetch?: unknown } | null)?.fetch !== 'function'
  ) {
    throw new Error(
      'Clerk error: clerkInstrumentHandler takes the MCP handler first: the handler createMcpHandler from @modelcontextprotocol/server returns, or a function of the request and its auth info. Call it as clerkInstrumentHandler(handler, { resourceUrl })',
    );
  }
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: clerkInstrumentHandler needs a resourceUrl to verify tokens with Clerk. Call it as clerkInstrumentHandler(handler, { resourceUrl: 'https://mcp.example.com/mcp' }), or as clerkInstrumentHandler(handler, { verifyToken }) with your own verifier`,
  );
  const { reporting: reportingOption, ...authOptions } = options;
  assertMcpAuthOptions('clerkInstrumentHandler', authOptions);
  const reporting = resolveReporting<Context>('clerkInstrumentHandler', reportingOption);
  const authenticate = honoAuthenticator(
    'clerkInstrumentHandler',
    authOptions,
    reporting &&
      ((c, answer) => {
        const keys = env<ClerkEnv>(c);
        // `readJsonBody` takes its copy now, before the answer, and reads it afterwards, so the request is untouched
        // and the answer never waits for the body
        const body = c.req.raw.bodyUsed
          ? requestWithBody(c).then((request) =>
              readJsonBody(request, undefined, AUTH_FAILURE_BODY_LIMIT),
            )
          : readJsonBody(c.req.raw, undefined, AUTH_FAILURE_BODY_LIMIT);
        const report = reportAuthFailure({
          caller: 'clerkInstrumentHandler',
          reporting,
          answer,
          body,
          request: c,
          defaultIpAddress: () => honoIpAddress(c),
          userAgent: () => c.req.header('user-agent'),
          env: { secretKey: keys.CLERK_SECRET_KEY, apiUrl: keys.CLERK_API_URL },
        })
          .then((send) => send?.())
          .catch(() => undefined);
        try {
          c.executionCtx.waitUntil(report);
        } catch {}
      }),
  );

  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticate(c);
    if (authenticated instanceof Response) return authenticated;
    const { authInfo } = authenticated;

    const request = await requestWithBody(c);
    if (authInfo) attachAuth(request, authInfo);
    const keys = env<ClerkEnv>(c);
    const context = beginToolCallContext({
      caller: 'clerkInstrumentHandler',
      reporting,
      authInfo,
      request: c,
      defaultIpAddress: () => honoIpAddress(c),
      userAgent: () => c.req.header('user-agent'),
      env: { secretKey: keys.CLERK_SECRET_KEY, apiUrl: keys.CLERK_API_URL },
    });

    const response =
      typeof handler === 'function'
        ? await handler(request, { authInfo })
        : await handler.fetch(request, { ...(authInfo && { authInfo }) });
    if (!context || !reporting) return response;

    let ended!: () => void;
    const end = new Promise<void>((resolve) => (ended = resolve));
    try {
      c.executionCtx.waitUntil(end.then(() => context.flush()));
    } catch {}
    return onResponseEnd(response, () => {
      checkToolCallContext('clerkInstrumentHandler', context, reporting, {
        method: c.req.method,
        status: response.status,
        mcpMethod: c.req.header('mcp-method'),
      });
      ended();
    });
  };
}

// The `auth` that `mcp-handler` and other fetch handlers read the auth info from, as `withClerkMcpAuth` sets it
function attachAuth(request: Request, authInfo: AuthInfo) {
  try {
    (request as Request & { auth?: AuthInfo }).auth = authInfo;
  } catch {}
}

/**
 * The client's address where the runtime reports it: `cf-connecting-ip` on Cloudflare Workers, whose requests have
 * `cf`, and the socket's address under `@hono/node-server`, which passes the Node.js request as `c.env.incoming`.
 */
function honoIpAddress(c: Context): string | undefined {
  if (typeof (c.req.raw as Request & { cf?: unknown }).cf === 'object') {
    return c.req.header('cf-connecting-ip');
  }
  const address = (c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return typeof address === 'string' ? address : undefined;
}
