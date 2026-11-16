import type { AuthInfo, McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMiddlewareAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertServerFactory,
  assertTransportClass,
  authenticateBearer,
  clerkClientResolver,
  authorizationServerMetadataAnswer,
  failureAnswer,
  methodNotAllowed,
  protectedResourceMetadataAnswer,
  readJsonBody,
  requestTokenVerifier,
  requireClerkEnvKeys,
  requirePublishableKey,
  serverErrorAnswer,
  type BearerResult,
} from '../bearer-auth';
import {
  type ClerkOAuthClient,
  type McpAuthFailure,
  McpAuthError,
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

/**
 * Options for the `mcpAuth` middleware. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as
 * its audience, and `clerkClient` defaults to one built from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the
 * app's environment. With `verifyToken`, that
 * function verifies each token with the Hono context, `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type McpAuthOptions = MiddlewareAuthOptions<Context>;

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions`, all optional, plus `properties`, so one object
 * can be passed to both. The handler reads `resourceUrl`, `requiredScopes`, `challengeScopes`, and `properties`, and
 * ignores the other `McpAuthOptions` keys: `clerkClient` and `verifyToken`.
 */
export type ProtectedResourceMetadataOptions =
  SharedProtectedResourceMetadataOptions<McpAuthOptions>;

/**
 * The part of a web-standard streamable HTTP server transport, such as `WebStandardStreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, that `streamableHttpHandler` uses.
 */
interface WebStandardStreamableHttpTransport {
  /**
   * Handles one MCP request.
   * @param request - The incoming request
   * @param options - The auth info of the request's verified token, if any
   * @returns The response to send
   */
  handleRequest(request: Request, options: { authInfo: AuthInfo | undefined }): Promise<Response>;
  /**
   * Closes the transport.
   * @returns A promise that resolves once the transport is closed
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

// The clients `mcpAuth` built from the environment, by settings. On Cloudflare Workers the settings are only known
// per request, on `c.env`, so the client can't be built at setup. The cache key is every setting the client is built
// from, so the secret is part of it; the map lives in memory only and is never logged or persisted. Two concurrent
// first requests for one set of settings can each build a client, and the later one replaces the earlier in the map;
// both work, so the duplicate is harmless.
const envClerkClients = new Map<string, ClerkOAuthClient>();

/**
 * The settings a Clerk client is built from, read from the app's environment through `env(c)`: the secret and
 * publishable keys, and `CLERK_API_URL`, `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set, as
 * `clerkMiddleware()` from `@clerk/hono` and the `clerkClient` from `@clerk/express` read them.
 * @param c - The Hono context of the request
 * @returns The settings, without the optional ones that are not set. It throws a `Clerk error:` naming the first key
 * not set.
 */
function requireClerkKeys(c: Context) {
  const {
    CLERK_SECRET_KEY,
    CLERK_PUBLISHABLE_KEY,
    CLERK_API_URL: apiUrl,
    CLERK_API_VERSION: apiVersion,
    CLERK_JWT_KEY: jwtKey,
  } = env<ClerkEnv>(c);
  const { CLERK_SECRET_KEY: secretKey, CLERK_PUBLISHABLE_KEY: publishableKey } =
    requireClerkEnvKeys('mcpAuth', { CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY });
  // Only the ones that are set, so `createClerkClient` keeps its own defaults for the others
  return {
    secretKey,
    publishableKey,
    ...(apiUrl && { apiUrl }),
    ...(apiVersion && { apiVersion }),
    ...(jwtKey && { jwtKey }),
  };
}

/**
 * The Clerk client built from the environment's keys, loading `@clerk/backend` the first time. The package is an
 * optional peer that only this path needs, so it is loaded with `import()` inside `try`: a bundler such as esbuild
 * fails the build on a bare `import()` of a missing package, but not on one inside `try`.
 * @param keys - The settings `requireClerkKeys` read
 * @returns The client, the same one for the same settings
 */
async function envClerkClient(keys: ReturnType<typeof requireClerkKeys>) {
  // `requireClerkKeys` builds the settings in one key order and leaves out the ones not set, so each set of settings
  // has one cache key
  const cacheKey = JSON.stringify(keys);
  const cached = envClerkClients.get(cacheKey);
  if (cached) return cached;

  let backend: typeof import('@clerk/backend');
  try {
    backend = await import('@clerk/backend');
  } catch (error) {
    throw new Error('Clerk error: install @clerk/backend, or pass clerkClient to mcpAuth', {
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
 * @param options - The options you give `mcpAuth`, and `properties`, additional metadata such as `resource_name`,
 * which overrides the generated metadata. `resourceUrl` makes the metadata's `resource` the URL `mcpAuth` checks;
 * without it, the `resource` is the URL the metadata route was requested at, without the well-known path.
 * `scopes_supported` lists `requiredScopes` then `challengeScopes`, unless `properties` sets it, and then that list
 * must include each of them.
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
  assertProtectedResourceMetadataOptions(options);

  return (c: Context) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 200, metadataCorsHeaders);
    const publishableKey = requirePublishableKey(env<ClerkEnv>(c).CLERK_PUBLISHABLE_KEY);
    const answer = protectedResourceMetadataAnswer(options, c.req.url, publishableKey);
    return c.json(answer.body, { status: answer.status, headers: answer.headers });
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
  // `arguments`, not a rest parameter, so the declared signature still takes no arguments
  assertAuthorizationServerMetadataHandlerCalled(arguments.length);
  return async (c: Context) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 200, metadataCorsHeaders);
    const publishableKey = requirePublishableKey(env<ClerkEnv>(c).CLERK_PUBLISHABLE_KEY);
    const answer = await authorizationServerMetadataAnswer(publishableKey);
    return c.json(answer.body, { status: answer.status, headers: answer.headers });
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
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, the `challengeScopes` the 401 challenge also asks for, and either the `clerkClient` that verifies tokens or a
 * `verifyToken` function. When a token lacks a `requiredScopes` entry, the 403 lists the granted scopes followed by
 * every missing `requiredScopes` and `challengeScopes` entry. A token that lacks only `challengeScopes` entries is let
 * through. `clerkClient` is a client, or a function that returns one, called once for each request. Without
 * `clerkClient`, it builds one with `createClerkClient` from `@clerk/backend`, from
 * `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` read through `env(c)`, with `CLERK_API_URL`, `CLERK_API_VERSION`,
 * and `CLERK_JWT_KEY` when they are set, kept for each set of those settings. Keep
 * `clerkMiddleware()` off the MCP route, which otherwise verifies each token a second time. A client from
 * `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check. `verifyToken` is called
 * with the token and the Hono context, and returns the auth data, or `undefined` to reject it.
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
export function mcpAuth(options: McpAuthOptions): MiddlewareHandler {
  assertMiddlewareAuthOptions(options);
  const clerkClientFor = clerkClientResolver(
    'mcpAuth',
    options.clerkClient,
    (c: Context) => envClerkClient(requireClerkKeys(c)),
    'a client built from CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY',
  );

  return async (c: Context, next: Next) => {
    const verifyToken = await requestTokenVerifier(options, clerkClientFor, c);

    let result: BearerResult;
    try {
      result = await authenticateBearer({
        options,
        authorization: c.req.header('authorization'),
        requestUrl: c.req.url,
        method: c.req.method,
        // A clone, so the MCP transport can still read the request
        body: async () => readJsonBody(await requestWithBody(c)),
        verifyToken,
      });
    } catch (error) {
      if (!(error instanceof McpAuthError)) throw error;
      throw withJsonResponse(error);
    }

    if (!result.ok) {
      if (result.failure) c.set('mcpAuthFailure', result.failure);
      const answer = failureAnswer(result);
      return c.json(answer.body, { status: answer.status, headers: answer.headers });
    }

    c.set('mcpAuth', result.authInfo);
    await next();
  };
}

/**
 * The readable request for `publicAccess` and the transport. Middleware that reads the body through the Hono
 * request, as `c.req.json()`, leaves the raw request unreadable, but Hono keeps what it read, so the request is
 * rebuilt around that while preserving its other properties.
 * @param c - The Hono context of the request
 * @returns The raw request, or a copy of it with the body Hono kept when the raw one was already read
 */
async function requestWithBody(c: Context): Promise<Request> {
  const { raw, bodyCache } = c.req;
  if (!raw.bodyUsed || Object.keys(bodyCache).length === 0) return raw;
  // From the URL and each field, as Hono's own `cloneRawRequest` does, not `new Request(raw, ...)`: on Node,
  // @hono/node-server's lightweight request is not a native `Request`, and with `overrideGlobalObjects: false` the
  // global `Request` reads it as a URL string and throws
  return new Request(raw.url, {
    method: raw.method,
    headers: raw.headers,
    body: await c.req.text(),
    cache: raw.cache,
    credentials: raw.credentials,
    integrity: raw.integrity,
    keepalive: raw.keepalive,
    mode: raw.mode,
    redirect: raw.redirect,
    referrer: raw.referrer,
    referrerPolicy: raw.referrerPolicy,
    signal: raw.signal,
  });
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
 */
export function streamableHttpHandler<
  Transport extends WebStandardStreamableHttpTransport,
  Server extends McpServerLike<Transport>,
>(createServer: () => Server, Transport: StreamableHttpTransportClass<Transport>) {
  assertServerFactory(createServer, 'WebStandardStreamableHTTPServerTransport');
  assertTransportClass(
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
