import { getAuth } from '@clerk/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo, McpServerFactory } from '@modelcontextprotocol/server';
import type express from 'express';
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

    // @ts-expect-error - we're monkey patching this on purpose
    req.auth = authData;

    next();
  };
}

/**
 * Express middleware that enforces authentication for MCP requests and automatically verifies the OAuth access token using Clerk.
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
 * transport, given a factory that returns an MCP server object from the MCP
 * SDK. The factory is called once per request — v2 transports are
 * per-request and stateless.
 * @param createServer - A factory returning a fresh MCP server object
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
export function streamableHttpHandler(createServer: McpServerFactory) {
  const handler = toNodeHandler(createMcpHandler(createServer));

  return async (req: express.Request, res: express.Response) => {
    await handler(req, res, req.body);
  };
}
