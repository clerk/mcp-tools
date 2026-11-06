import { clerkClient, getAuth } from '@clerk/express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type express from 'express';
import {
  type ClerkMcpAuthOptions,
  type McpAuthOptions,
  assertMcpAuthOptions,
  authenticateBearer,
  resourceMetadataUrlFor,
  verifyClerkOAuthToken,
} from '../bearer-auth';
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  verifyClerkToken,
} from '../server';

/**
 * Express middleware that enforces authentication for MCP requests.
 * @param verifyToken - A function that verifies a token and returns either the
 * auth data or false
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
 * app.post("/mcp", mcpAuth(verifyToken), streamableHttpHandler(createServer));
 * ```
 */
export function mcpAuth(
  verifyToken: (token: string, req: express.Request) => Promise<AuthInfo | undefined>,
  options?: McpAuthOptions,
) {
  assertMcpAuthOptions('mcpAuth', options);

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const result = await authenticateBearer({
      authorization: req.headers.authorization,
      resourceMetadataUrl: options?.resourceUrl
        ? resourceMetadataUrlFor(options.resourceUrl)
        : getPRMUrl(req),
      requiredScopes: options?.requiredScopes,
      verifyToken: (token) => verifyToken(token, req),
    });

    if (!result.ok) {
      res
        .status(result.status)
        .set('WWW-Authenticate', result.challenge)
        .json({ error: result.error });
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
 * and the `requiredScopes` every request needs
 * @returns The middleware. A missing or rejected token gets a 401 challenge,
 * and a token without `requiredScopes` gets a 403 challenge.
 * @example
 * ```ts
 * app.post(
 *   "/mcp",
 *   clerkMcpAuth({
 *     resourceUrl: "https://mcp.example.com/mcp",
 *     requiredScopes: ["profile", "email"],
 *   }),
 *   streamableHttpHandler(createServer),
 * );
 * ```
 */
export function clerkMcpAuth(options: ClerkMcpAuthOptions) {
  assertMcpAuthOptions('clerkMcpAuth', options);
  return mcpAuth(
    (token) => verifyClerkOAuthToken(clerkClient, token, options.resourceUrl),
    options,
  );
}

/**
 * Express middleware that enforces authentication for MCP requests and automatically verifies the OAuth access token using Clerk.
 * @deprecated This does not check the token's audience, so a token issued for another resource passes. Use `clerkMcpAuth`.
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
 * app.post("/mcp", mcpAuthClerk, streamableHttpHandler(createServer));
 * ```
 */
export const mcpAuthClerk = mcpAuth(async (token, req) => {
  const authData = getAuth(req, { acceptsToken: 'oauth_token' });

  if (!authData.isAuthenticated) return undefined;

  return verifyClerkToken(authData, token);
});

/**
 * An express handler that returns OAuth protected resource metadata.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-4.1
 * @param authServerUrl - The URL of the authorization server
 * @param properties - Additional properties to include in the metadata
 * @example
 * ```ts
 * app.get(
 *   "/.well-known/oauth-protected-resource",
 *   protectedResourceHandler({
 *     authServerUrl: "https://auth.example.com",
 *     properties: {
 *       service_documentation: "https://example.com/docs"
 *     }
 *   })
 * );
 * ```
 */
export function protectedResourceHandler({
  authServerUrl,
  properties,
}: {
  authServerUrl: string;
  properties?: Record<string, unknown>;
}) {
  return async (req: express.Request, res: express.Response) => {
    const metadata = generateProtectedResourceMetadata({
      authServerUrl,
      resourceUrl: getResourceUrl(req),
      properties,
    });

    res.json(metadata);
  };
}

export async function authServerMetadataHandlerClerk(_: express.Request, res: express.Response) {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
  }

  const metadata = await fetchClerkAuthorizationServerMetadata({
    publishableKey,
  });

  res.json(metadata);
}

/**
 * An express handler that will return OAuth protected resource metadata if you're using Clerk.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-4.1
 * @example
 * ```ts
 * app.get(
 *   "/.well-known/oauth-protected-resource",
 *   protectedResourceHandlerClerk
 * );
 * ```
 */
export function protectedResourceHandlerClerk(properties?: Record<string, unknown>) {
  return (req: express.Request, res: express.Response) => {
    const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
    }

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: getResourceUrl(req),
      properties,
    });

    res.json(metadata);
  };
}

// Given a protected resource metadata url generate the url of the original
// resource
function getResourceUrl(req: express.Request) {
  const url = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  url.pathname = url.pathname.replace(/\.well-known\/oauth-protected-resource\/?/, '');
  return url.toString();
}

// Get given a request, generate a protected resource metadata url for the
// given resource url
function getPRMUrl(req: express.Request) {
  const [pathname] = req.originalUrl.split('?');
  return `${req.protocol}://${req.get('host')}/.well-known/oauth-protected-resource${pathname}`;
}

/**
 * An express handler that will handle MCP requests using the streamable http
 * transport, given a factory that creates an MCP server object from the MCP
 * SDK. A fresh server and transport are created for each request so that
 * concurrent requests don't share state.
 * @param createServer - A factory that returns a new MCP server object. A
 * plain server object is also accepted for backwards compatibility, but a
 * shared server can only handle one request at a time, so passing a factory
 * is strongly recommended.
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
 * app.post("/mcp", streamableHttpHandler(createServer));
 * ```
 */
export function streamableHttpHandler(createServer: McpServer | (() => McpServer)) {
  return async (req: express.Request, res: express.Response) => {
    const server = typeof createServer === 'function' ? createServer() : createServer;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

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
