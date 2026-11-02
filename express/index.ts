import { getAuth } from '@clerk/express';
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
import { assertToolScopes, scopeChallengeHeader, type ToolScopes } from '../scope-challenge';

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
 * app.post("/mcp", await mcpAuth(verifyToken), streamableHttpHandler(createServer));
 * ```
 */
export async function mcpAuth(
  verifyToken: (token: string, req: express.Request) => Promise<AuthInfo | undefined>,
  options: {
    /**
     * Scopes each tool needs. A `tools/call` for a tool whose scopes the token lacks gets a 403 step-up challenge.
     * Reads `req.body`, so register `express.json()` first. A `POST` with a body it did not parse gets a 415.
     */
    toolScopes?: ToolScopes;
  } = {},
) {
  if (options.toolScopes) assertToolScopes('mcpAuth', options.toolScopes);
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> => {
    const prmUrl = getPRMUrl(req);

    if (!req.headers.authorization) {
      res
        .status(401)
        .set({
          'WWW-Authenticate': `Bearer resource_metadata=${prmUrl}`,
        })
        .send({
          error: 'Unauthorized',
        });
      return;
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
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Only a POST carries JSON-RPC messages, so only a POST can call a tool.
    if (options.toolScopes && req.method === 'POST') {
      if (req.body === undefined) {
        // A JSON body that no parser read means express.json() is missing, and the challenge would never fire.
        if (req.is('json')) {
          throw new Error(
            'Clerk error: mcpAuth toolScopes reads the parsed request body, so register express.json() before mcpAuth',
          );
        }
        // express.json() skips other types, but the transport parses any Content-Type that contains
        // application/json, so an unread body would reach the tools without the challenge.
        res.status(415).json({ error: 'Unsupported Media Type' });
        return;
      }
      const challenge = scopeChallengeHeader({
        body: req.body,
        authInfo: authData,
        toolScopes: options.toolScopes,
        resourceMetadataUrl: prmUrl,
      });
      if (challenge) {
        res.status(403).set('WWW-Authenticate', challenge).json({ error: 'Forbidden' });
        return;
      }
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
