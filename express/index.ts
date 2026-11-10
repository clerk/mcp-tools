import { clerkClient } from '@clerk/express';
import type { McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type express from 'express';
import {
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMiddlewareAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertServerFactory,
  assertTransportClass,
  authenticateBearer,
  clerkProtectedResourceMetadata,
  clerkTokenVerifier,
  requirePublishableKey,
} from '../bearer-auth';
import { type McpAuthFailure, fetchAuthorizationServerMetadata } from '../server';

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
 * can be passed to both. It ignores `clerkClient` and `verifyToken`.
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
 * `verifyToken` function. Pass the client you gave `clerkMiddleware()` when the secret key does not come from
 * `CLERK_SECRET_KEY`; it defaults to `clerkClient` from `@clerk/express`. Create the client with both `secretKey` and
 * `publishableKey`: without a publishable key, every request fails. A client from `@clerk/backend` must be version
 * 3.19.0 or later, the first with a reliable audience check. `verifyToken` is called with the token and the request,
 * and returns the auth data, or `undefined` to reject it.
 * @returns The middleware. A missing or rejected token gets a 401 challenge, a token without `requiredScopes` gets a
 * 403 challenge, and a request to an origin no `resourceUrl` lists gets a 421. The reason is recorded on
 * `res.locals.mcpAuthFailure`.
 * @example
 * ```ts
 * app.post(
 *   "/mcp",
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
 * app.post(
 *   "/mcp",
 *   mcpAuth({ verifyToken, resourceUrl: "https://mcp.example.com/mcp" }),
 *   streamableHttpHandler(createServer, StreamableHTTPServerTransport),
 * );
 * ```
 */
export function mcpAuth(options: McpAuthOptions) {
  assertMiddlewareAuthOptions(options);
  const verifyToken =
    options.verifyToken ??
    clerkTokenVerifier(
      options,
      () => options.clerkClient ?? clerkClient,
      // The middleware answers a request without a usable URL before it verifies a token
      (req: express.Request) => getRequestUrl(req)!,
    );

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // A missing `Host` header, or one that does not parse, would otherwise throw below and reach the app as a server
    // error, or derive a challenge for `http://undefined`
    const requestUrl = getRequestUrl(req);
    if (!requestUrl) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = await authenticateBearer({
      authorization: req.headers.authorization,
      requestUrl,
      resourceUrl: options.resourceUrl,
      requiredScopes: options.requiredScopes,
      challengeScopes: options.challengeScopes,
      verifyToken: (token) => verifyToken(token, req),
    });

    if (!result.ok) {
      res.locals.mcpAuthFailure = result.failure;
      res.status(result.status);
      if (result.challenge) res.set('WWW-Authenticate', result.challenge);
      res.json({ error: result.error });
      return;
    }

    // @ts-expect-error - we're monkey patching this on purpose
    req.auth = result.authInfo;

    next();
  };
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
  return async (_: express.Request, res: express.Response) => {
    const publishableKey = requirePublishableKey(process.env.CLERK_PUBLISHABLE_KEY);

    const metadata = await fetchAuthorizationServerMetadata({
      publishableKey,
    });

    res.json(metadata);
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
    const publishableKey = requirePublishableKey(process.env.CLERK_PUBLISHABLE_KEY);

    const requestUrl = getRequestUrl(req);
    if (!requestUrl) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const metadata = clerkProtectedResourceMetadata(options, requestUrl, publishableKey);
    if (!metadata) {
      res.status(421).json({ error: 'misdirected_request' });
      return;
    }

    res.json(metadata);
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
 * app.post("/mcp", streamableHttpHandler(createServer, StreamableHTTPServerTransport));
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
