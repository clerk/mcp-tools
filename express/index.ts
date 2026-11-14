import type { McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type express from 'express';
import {
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  PUBLIC_BODY_LIMIT,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMiddlewareAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertServerFactory,
  assertTransportClass,
  authenticateBearer,
  clerkClientResolver,
  clerkProtectedResourceMetadata,
  failureBody,
  failureHeaders,
  metadataResponseHeaders,
  metadataUnavailableAnswer,
  methodNotAllowed,
  requestTokenVerifier,
  requirePublishableKey,
  serverErrorAnswer,
} from '../bearer-auth';
import {
  type ClerkOAuthClient,
  type McpAuthFailure,
  McpAuthError,
  fetchAuthorizationServerMetadata,
  metadataCorsHeaders,
} from '../server';

declare global {
  namespace Express {
    interface Locals {
      /**
       * Why `mcpAuth` answered this request with a 401 or 403 challenge or a 421, when it did.
       */
      mcpAuthFailure?: McpAuthFailure;
    }
  }
}

// Everything in the core subpath, so an Express app imports from this subpath alone
export * from '../server';

/**
 * Options for the `mcpAuth` middleware. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as
 * its audience, and `clerkClient` defaults to `clerkClient` from `@clerk/express`. With `verifyToken`, that function
 * verifies each token with the Express request, `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type McpAuthOptions = MiddlewareAuthOptions<express.Request>;

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions`, all optional, plus `properties`, so one object
 * can be passed to both. The handler reads `resourceUrl`, `requiredScopes`, `challengeScopes`, and `properties`, and
 * ignores the other `McpAuthOptions` keys: `clerkClient` and `verifyToken`.
 */
export type ProtectedResourceMetadataOptions =
  SharedProtectedResourceMetadataOptions<McpAuthOptions>;

/**
 * The part of a Node.js streamable HTTP server transport, such as `StreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/streamableHttp.js`, that `streamableHttpHandler` uses.
 */
interface NodeStreamableHttpTransport {
  /**
   * Handles one MCP request and writes the response.
   * @param req - The incoming request, carrying the auth info `mcpAuth` set in `req.auth`
   * @param res - The response to write to
   * @param parsedBody - The request body, already parsed
   * @returns A promise that resolves once the request is handled
   */
  handleRequest(req: express.Request, res: express.Response, parsedBody: unknown): Promise<void>;
  /**
   * Closes the transport.
   * @returns A promise that resolves once the transport is closed
   */
  close(): Promise<void>;
}

/**
 * Express middleware that enforces authentication for MCP requests. By default it verifies the OAuth access token with
 * Clerk, including that its audience is this endpoint; pass `verifyToken` to verify tokens with your own function.
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, the `challengeScopes` the 401 challenge also asks for, and either the `clerkClient` that verifies tokens or a
 * `verifyToken` function. When a token lacks a `requiredScopes` entry, the 403 lists the granted scopes followed by
 * every missing `requiredScopes` and `challengeScopes` entry. A token that lacks only `challengeScopes` entries is let
 * through. `clerkClient` defaults to `clerkClient` from `@clerk/express`, which reads
 * `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`; pass your own, or a function that returns one, called once for
 * each request, when the keys come from elsewhere. The route doesn't need
 * `clerkMiddleware()`: this middleware verifies the token itself. Create the client with both `secretKey` and
 * `publishableKey`: without a publishable key, every request fails. A client from `@clerk/backend` must be version
 * 3.19.0 or later, the first with a reliable audience check. `verifyToken` is called with the token and the request,
 * and returns the auth data, or `undefined` to reject it.
 * @returns The middleware. A missing or rejected token gets a 401 challenge, a token without `requiredScopes` gets a
 * 403 challenge, and a request to an origin no `resourceUrl` lists gets a 421. The reason is recorded on
 * `res.locals.mcpAuthFailure`. A token that could not be verified at all gets a JSON server error, and the
 * `McpAuthError` is logged with `console.error`. Without a `clerkClient` option, every request throws a
 * `Clerk error:` naming a missing key, or asking to install `@clerk/express` when it can't be loaded.
 * @example
 * ```ts
 * // Every method, so a GET without a token gets the 401 (or the 405 with publicAccess) rather than a 404
 * app.all(
 *   "/mcp",
 *   express.json(),
 *   mcpAuth({
 *     resourceUrl: "https://mcp.example.com/mcp",
 *     requiredScopes: ["profile", "email"],
 *   }),
 *   streamableHttpHandler(createServer, StreamableHTTPServerTransport),
 * );
 * ```
 * @example
 * ```ts
 * async function verifyToken(token, req) {
 *   const authData = // verify the token and return the auth data
 *   return authData;
 * }
 *
 * app.all(
 *   "/mcp",
 *   express.json(),
 *   mcpAuth({ verifyToken, resourceUrl: "https://mcp.example.com/mcp" }),
 *   streamableHttpHandler(createServer, StreamableHTTPServerTransport),
 * );
 * ```
 */
export function mcpAuth(options: McpAuthOptions) {
  assertMiddlewareAuthOptions(options);
  const clerkClientFor = clerkClientResolver(
    'mcpAuth',
    options.clerkClient,
    expressClerkClient,
    "clerkClient from '@clerk/express'",
  );

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const verifyToken = await requestTokenVerifier(
      options,
      clerkClientFor,
      req,
      // The middleware answers a request without a usable URL before it verifies a token
      (request: express.Request) => getRequestUrl(request)!,
    );

    // A missing `Host` header, or one that does not parse, would otherwise throw below and reach the app as a server
    // error, or derive a challenge for `http://undefined`
    const requestUrl = getRequestUrl(req);
    if (!requestUrl) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    let result: Awaited<ReturnType<typeof authenticateBearer>>;
    try {
      result = await authenticateBearer({
        // Every `Authorization` value, joined as fetch `Headers` join them for the other adapters, so two headers are
        // challenged as malformed. `req.headers.authorization` keeps only the first, and would verify that one.
        authorization: req.headersDistinct.authorization?.join(', '),
        requestUrl,
        resourceUrl: options.resourceUrl,
        requiredScopes: options.requiredScopes,
        challengeScopes: options.challengeScopes,
        publicAccess: options.publicAccess,
        method: req.method,
        body: () => parsedJsonBody(req),
        verifyToken,
      });
    } catch (error) {
      if (!(error instanceof McpAuthError)) throw error;
      // Logged here, not passed to `next`: Express's default error handler destroys the socket of a sent response,
      // which resets a client still uploading its body, and `finish` never fires when the client disconnects
      const answer = serverErrorAnswer(error);
      console.error(error);
      res.status(answer.status).json(answer.body);
      return;
    }

    if (!result.ok) {
      if (result.failure) res.locals.mcpAuthFailure = result.failure;
      res.status(result.status).set(failureHeaders(result)).json(failureBody(result));
      return;
    }

    // For a request `publicAccess` let through this is `undefined`, which also clears an `auth` that another
    // middleware set, so the MCP transport never takes one for the auth info of a token.
    // @ts-expect-error - we're monkey patching this on purpose
    req.auth = result.authInfo;

    next();
  };
}

/**
 * `clerkClient` from `@clerk/express`. The package is an optional peer that only this path needs, so it is loaded with
 * `import()` inside `try`, and an app that passes `verifyToken` or its own `clerkClient` does not need it installed.
 * @returns The client. It throws a `Clerk error:` asking to install `@clerk/express` when the package can't be loaded,
 * with the load error as the `cause`, or naming `CLERK_SECRET_KEY` or `CLERK_PUBLISHABLE_KEY` when it is not set.
 */
async function expressClerkClient(): Promise<ClerkOAuthClient> {
  let clerkExpress: typeof import('@clerk/express');
  try {
    clerkExpress = await import('@clerk/express');
  } catch (error) {
    throw new Error('Clerk error: install @clerk/express, or pass clerkClient to mcpAuth', {
      cause: error,
    });
  }
  // `@clerk/express` reads both keys from the environment only when a token is verified, and a missing one would then
  // look like a Clerk outage, so they are checked here as Hono's adapter checks its own
  for (const name of ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY']) {
    if (!process.env[name]) {
      throw new Error(
        `Clerk error: mcpAuth needs the ${name} environment variable or a clerkClient option`,
      );
    }
  }
  return clerkExpress.clerkClient;
}

/**
 * The JSON body `express.json()` parsed, which `publicAccess` checks. Without that middleware a JSON request has no
 * parsed body, and every request without a token would get a 401 with nothing to say why, so that case throws.
 * `express.json()` has already buffered the body by then, up to its own `limit`, so that `limit` is what bounds the
 * bytes a request without a token sends: set it, as `express.json({ limit })`, at or below the size you accept from
 * anonymous clients. Its 100kb default is below `PUBLIC_BODY_LIMIT`. The `PUBLIC_BODY_LIMIT` check here is defence in
 * depth that keeps the rule the other adapters follow: a body larger than that is not public. Without a
 * `Content-Length`, as for a chunked body, the size is that of the parsed body serialized again, which is not the byte
 * count sent: whitespace and number formatting differ, so padding can carry a chunked body past 1 MiB that still
 * counts as under it. Only `express.json()`'s `limit` bounds the original bytes. Only a body sent as
 * `application/json` is checked, as in the other adapters, so a body another parser read, such as a form
 * `express.urlencoded()` parsed, is not public.
 * @param req - The incoming request
 * @returns The parsed body, or `undefined` when the request has no JSON body or is over `PUBLIC_BODY_LIMIT`
 */
function parsedJsonBody(req: express.Request): unknown {
  if (!req.is('application/json')) return undefined;
  if (req.body === undefined) {
    throw new Error(
      'Clerk error: mcpAuth publicAccess reads the parsed JSON body of the request. Mount express.json() before mcpAuth, as app.use(express.json())',
    );
  }
  const declared = req.get('content-length');
  if (declared !== undefined) return Number(declared) > PUBLIC_BODY_LIMIT ? undefined : req.body;
  return Buffer.byteLength(JSON.stringify(req.body)) > PUBLIC_BODY_LIMIT ? undefined : req.body;
}

/**
 * An Express handler that serves the RFC 8414 authorization server metadata of the Clerk instance named by
 * `CLERK_PUBLISHABLE_KEY`, fetched from its Frontend API on each request.
 * @see https://datatracker.ietf.org/doc/html/rfc8414#section-3
 * @returns The handler. It throws when `CLERK_PUBLISHABLE_KEY` is not set. Passing
 * `authorizationServerMetadataHandler` to the route without calling it throws a `Clerk error:` on the first request.
 * @example
 * ```ts
 * app.get(
 *   "/.well-known/oauth-authorization-server",
 *   authorizationServerMetadataHandler()
 * );
 * ```
 */
export function authorizationServerMetadataHandler() {
  // `arguments`, not a rest parameter, so the declared signature still takes no arguments
  assertAuthorizationServerMetadataHandlerCalled(arguments.length);
  return async (req: express.Request, res: express.Response) => {
    if (req.method === 'OPTIONS') {
      res.status(200).set(metadataCorsHeaders).end();
      return;
    }
    const publishableKey = requirePublishableKey(process.env.CLERK_PUBLISHABLE_KEY);

    let metadata: unknown;
    try {
      metadata = await fetchAuthorizationServerMetadata({ publishableKey });
    } catch (error) {
      // The CORS headers, so a browser client can read the error, but not the caching ones metadata gets
      const answer = metadataUnavailableAnswer(error);
      res.status(answer.status).set(metadataCorsHeaders).json(answer.body);
      return;
    }

    res.set(metadataResponseHeaders).json(metadata);
  };
}

/**
 * An Express handler that serves RFC 9728 protected resource metadata for the Clerk instance named by
 * `CLERK_PUBLISHABLE_KEY`. Mount it at the path `mcpAuth`'s challenge points to.
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
 *   "/.well-known/oauth-protected-resource/mcp",
 *   protectedResourceMetadataHandler({ resourceUrl: "https://mcp.example.com/mcp" })
 * );
 * ```
 */
export function protectedResourceMetadataHandler(options: ProtectedResourceMetadataOptions = {}) {
  assertProtectedResourceMetadataOptions(options);

  return (req: express.Request, res: express.Response) => {
    if (req.method === 'OPTIONS') {
      res.status(200).set(metadataCorsHeaders).end();
      return;
    }
    const publishableKey = requirePublishableKey(process.env.CLERK_PUBLISHABLE_KEY);

    const requestUrl = getRequestUrl(req);
    if (!requestUrl) {
      res.status(400).set(metadataCorsHeaders).json({ error: 'invalid_request' });
      return;
    }

    const metadata = clerkProtectedResourceMetadata(options, requestUrl, publishableKey);
    if (!metadata) {
      res.status(421).set(metadataCorsHeaders).json({ error: 'misdirected_request' });
      return;
    }

    res.set(metadataResponseHeaders).json(metadata);
  };
}

// The URL the request was made to, or `undefined` without a `Host` header that parses. Behind a proxy, `req.protocol`
// and the host come from `X-Forwarded-*` headers only when the app sets `trust proxy`. `req.host` is the one that reads
// `X-Forwarded-Host` then; `req.get('host')` is always the raw `Host` header.
function getRequestUrl(req: express.Request): string | undefined {
  const host = req.host as string | undefined;
  if (!host) return undefined;
  const url = `${req.protocol}://${host}${req.originalUrl}`;
  return URL.canParse(url) ? url : undefined;
}

/**
 * An express handler that will handle MCP requests using the streamable http
 * transport, given a factory that creates an MCP server object from the MCP
 * SDK. A fresh server and transport are created for each request so that
 * concurrent requests don't share state.
 * @param createServer - A factory that returns a new MCP server, such as
 * `McpServer` from the MCP SDK, on every call. Passing a server object
 * instead throws when the handler is created.
 * @param Transport - The SDK's Node.js transport class,
 * `StreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/streamableHttp.js`. It is taken as an
 * argument so that this package never imports the SDK, which only apps serving
 * MCP with this handler need to install.
 * @returns The handler
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
 *
 * function createServer() {
 *   const server = new McpServer({
 *     name: "test-server",
 *     version: "0.0.1",
 *   });
 *
 *   // define server tools, resources, etc...
 *
 *   return server;
 * }
 *
 * // A request that isn't a POST gets a 405 with `Allow: POST`: the server is stateless
 * app.all("/mcp", express.json(), streamableHttpHandler(createServer, StreamableHTTPServerTransport));
 * ```
 * @typeParam Transport - The transport the class creates, inferred from the
 * class alone
 * @typeParam Server - The server `createServer` returns. It is a separate type
 * parameter so that `Transport` is not inferred from the SDK's general
 * `Transport` interface, which `McpServer.connect` takes.
 */
export function streamableHttpHandler<
  Transport extends NodeStreamableHttpTransport,
  Server extends McpServerLike<Transport>,
>(createServer: () => Server, Transport: StreamableHttpTransportClass<Transport>) {
  assertServerFactory(createServer, 'StreamableHTTPServerTransport');
  assertTransportClass(Transport, 'StreamableHTTPServerTransport', 'streamableHttp.js');

  return async (req: express.Request, res: express.Response) => {
    if (req.method !== 'POST') {
      res.status(methodNotAllowed.status).set(methodNotAllowed.headers).json(methodNotAllowed.body);
      return;
    }

    const server = createServer();
    const transport = new Transport({ sessionIdGenerator: undefined });

    // close() rejects if a consumer onclose hook throws; an unhandled rejection would kill the process
    const closeTransport = () => transport.close().catch(() => undefined);

    // closing detaches the transport; otherwise the next connect() throws and kills the endpoint
    res.on('close', closeTransport);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await closeTransport();
      throw error;
    }
  };
}
