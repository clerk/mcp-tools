import { authenticateRequest, clerkClient, getAuth } from '@clerk/express';
import type { MachineAuthObject } from '@clerk/backend';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type express from 'express';
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  verifyClerkToken,
} from '../server';
import {
  type McpAuthClerkOptions,
  resolveMcpAuthClerkOptions,
  tokenMatchesAudience,
  withResourceMetadataUrl,
} from '../mcp-auth-options';

export type { McpAuthClerkOptions };

/**
 * Express middleware that enforces authentication for MCP requests.
 * @param verifyToken - A function that verifies a token and returns either the
 * auth data or false
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
export async function mcpAuth(
  verifyToken: (token: string, req: express.Request) => Promise<AuthInfo | undefined>,
) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const prmUrl = getPRMUrl(req);

    if (!req.headers.authorization) {
      return res
        .status(401)
        .set({
          'WWW-Authenticate': `Bearer resource_metadata=${prmUrl}`,
        })
        .send({
          error: 'Unauthorized',
        });
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      throw new Error(
        `Invalid authorization header value, expected Bearer <token>, received ${authHeader}`,
      );
    }

    const authData = await verifyToken(token, req);

    if (!authData) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Monkey patched on purpose: the MCP transports read `req.auth`, which Express does not declare for them.
    (req as express.Request & { auth?: AuthInfo }).auth = authData;

    next();
  };
}

/**
 * Express middleware that enforces authentication for MCP requests and verifies the OAuth access token using Clerk,
 * with no audience check. Prefer `createMcpAuthClerk`, which checks the audience and sets `resourceMetadataUrl`.
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
export async function mcpAuthClerk(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  (
    await mcpAuth(async (token, req: express.Request) => {
      const authData = getAuth(req, { acceptsToken: 'oauth_token' });

      if (!authData.isAuthenticated) return undefined;

      return verifyClerkToken(authData, token);
    })
  )(req, res, next);
}

/**
 * Creates Express middleware that enforces authentication for MCP requests: it verifies the OAuth access token using
 * Clerk, refuses a token that was not issued for `audience` with `401`, and stores auth info that carries
 * `resourceMetadataUrl`. It sets `req.auth`, which `streamableHttpHandler` and the MCP SDK 2.x Node adapters read.
 * It does not need `clerkMiddleware()`. Without an audience check, any OAuth token that your Clerk instance issued
 * could call your tools. Throws a `Clerk error:` message when `audience` is missing or empty.
 * The audience is also checked here for JWT access tokens (the `aud` claim must overlap `audience`), so an older Clerk
 * SDK that ignores the `audience` option still cannot accept a token for another resource. Opaque tokens have no `aud`
 * to read here, so only Clerk's check covers them, and that needs `@clerk/backend` 3.19.0 or later.
 * @example
 * ```ts
 * import { toNodeHandler } from "@modelcontextprotocol/node";
 * import { createMcpHandler } from "@modelcontextprotocol/server";
 *
 * const mcpHandler = toNodeHandler(createMcpHandler(createServer));
 * const mcpAuth = createMcpAuthClerk({ audience: "https://mcp.example.com/mcp" });
 *
 * app.post("/mcp", mcpAuth, (req, res) => mcpHandler(req, res, req.body));
 * ```
 */
export function createMcpAuthClerk(options: McpAuthClerkOptions) {
  const { audience, resourceMetadataUrl } = resolveMcpAuthClerkOptions(options);
  const middleware = mcpAuth(async (token, req: express.Request) => {
    const requestState = await authenticateRequest({
      clerkClient,
      request: req,
      options: { acceptsToken: 'oauth_token', audience },
    });
    const authData = requestState.toAuth() as unknown as MachineAuthObject<'oauth_token'>;
    // The same token that Clerk verified and that goes into the auth info.
    const authInfo = tokenMatchesAudience(token, audience)
      ? verifyClerkToken(authData, token)
      : undefined;
    return authInfo && withResourceMetadataUrl(authInfo, resourceMetadataUrl ?? getPRMUrl(req));
  });
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> => {
    await (
      await middleware
    )(req, res, next);
  };
}

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
  return `${req.protocol}://${req.get(
    'host',
  )}/.well-known/oauth-protected-resource${req.originalUrl}`;
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
