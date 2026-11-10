import { clerkClient } from '@clerk/express';
import type { AuthInfo, McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type express from 'express';
import {
  type ClerkOAuthClient,
  type McpAuthClerkOptions,
  type McpAuthFailure,
  type McpAuthOptions,
  type McpResourceUrl,
  McpAuthError,
  McpTokenVerificationError,
  assertMcpAuthClerkOptions,
  assertMcpAuthOptions,
  assertServerFactory,
  assertTransportClass,
  audienceFor,
  authenticateBearer,
  resourceFromMetadataUrl,
  verifyClerkOAuthToken,
} from '../bearer-auth';
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
} from '../server';

declare global {
  namespace Express {
    interface Locals {
      /** Why `mcpAuth` answered this request with a 401 or 403 challenge or a 421, when it did. */
      mcpAuthFailure?: McpAuthFailure;
    }
  }
}

export {
  type ClerkOAuthClient,
  McpAuthError,
  type McpAuthClerkOptions,
  type McpAuthFailure,
  type McpAuthOptions,
  type McpResourceUrl,
  type McpServerLike,
  McpTokenVerificationError,
  type StreamableHttpTransportClass,
};

/**
 * The part of a Node.js streamable HTTP server transport, such as `StreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/streamableHttp.js`, that `streamableHttpHandler` uses.
 */
export interface NodeStreamableHttpTransport {
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
 * Express middleware that enforces authentication for MCP requests.
 * @param verifyToken - A function that verifies a token and returns the auth
 * data, or `undefined` to reject it
 * @param options - The public `resourceUrl` of this endpoint and the
 * `requiredScopes` every request needs
 * @returns The middleware. A missing or rejected token gets a 401 challenge,
 * and a token without `requiredScopes` gets a 403 challenge.
 * @example
 * ```ts
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
 * async function verifyToken(token, req) {
 *   const authData = // verify the token and return the auth data
 *   return authData;
 * }
 *
 * app.post(
 *   "/mcp",
 *   mcpAuth(verifyToken),
 *   streamableHttpHandler(createServer, StreamableHTTPServerTransport),
 * );
 * ```
 */
export function mcpAuth(
  verifyToken: (token: string, req: express.Request) => Promise<AuthInfo | undefined>,
  options?: McpAuthOptions,
) {
  assertMcpAuthOptions('mcpAuth', options);

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
      resourceUrl: options?.resourceUrl,
      requiredScopes: options?.requiredScopes,
      challengeScopes: options?.challengeScopes,
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
 * Express middleware that enforces authentication for MCP requests and verifies the OAuth access token with Clerk,
 * including that its audience is this endpoint.
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint,
 * the `requiredScopes` every request needs, and the `clerkClient` that
 * verifies tokens. Pass the client you gave `clerkMiddleware()` when the
 * secret key does not come from `CLERK_SECRET_KEY`; it defaults to
 * `clerkClient` from `@clerk/express`. Create the client with both
 * `secretKey` and `publishableKey`: without a publishable key, every request
 * fails. A client from `@clerk/backend` must be version 3.19.0 or later, the
 * first with a reliable audience check.
 * @returns The middleware. A missing or rejected token gets a 401 challenge,
 * and a token without `requiredScopes` gets a 403 challenge.
 * @example
 * ```ts
 * app.post(
 *   "/mcp",
 *   mcpAuthClerk({
 *     resourceUrl: "https://mcp.example.com/mcp",
 *     requiredScopes: ["profile", "email"],
 *   }),
 *   streamableHttpHandler(createServer, StreamableHTTPServerTransport),
 * );
 * ```
 */
export function mcpAuthClerk(
  options: McpAuthClerkOptions & {
    clerkClient?: ClerkOAuthClient | undefined;
  },
) {
  assertMcpAuthClerkOptions(options);
  const client = options.clerkClient ?? clerkClient;
  return mcpAuth(
    (token, req) =>
      // `mcpAuth` answers a request without a usable URL before it calls this
      verifyClerkOAuthToken(client, token, audienceFor(options.resourceUrl, getRequestUrl(req)!)),
    options,
  );
}

export function authServerMetadataHandler() {
  return async (_: express.Request, res: express.Response) => {
    const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
    }

    const metadata = await fetchClerkAuthorizationServerMetadata({
      publishableKey,
    });

    res.json(metadata);
  };
}

/**
 * An express handler that will return OAuth protected resource metadata if you're using Clerk.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-4.1
 * @example
 * ```ts
 * app.get(
 *   "/.well-known/oauth-protected-resource/mcp",
 *   protectedResourceHandler()
 * );
 * ```
 */
export function protectedResourceHandler(properties?: Record<string, unknown>) {
  return (req: express.Request, res: express.Response) => {
    const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
    }

    const requestUrl = getRequestUrl(req);
    if (!requestUrl) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: resourceFromMetadataUrl(requestUrl),
      properties,
    });

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
