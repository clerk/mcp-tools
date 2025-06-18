import type express from "express";
import {
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
} from "../server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuth } from "@clerk/express";

/**
 * Express middleware that enforces authentication for MCP requests.
 * @param verifyToken - A function that verifies a token and returns either the
 * auth data or false
 * @example
 * ```ts
 * const server = new McpServer({
 *   name: "test-server",
 *   version: "0.0.1",
 * });
 *
 * // define server tools, resources, etc...
 *
 * async function verifyToken(token, req) {
 *   const authData = // verify the token and return the auth data
 *   return authData;
 * }
 *
 * app.get("/mcp", mcpAuth(verifyToken), streamableHttpHandler(server));
 * ```
 */
export async function mcpAuth(
  verifyToken: (token: string, req: express.Request) => Promise<any | false>
) {
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const origin = getOrigin(req);

    if (!req.headers["authorization"]) {
      return res
        .status(401)
        .set({
          "WWW-Authenticate": `Bearer resource_metadata=${origin}/.well-known/oauth-protected-resource`,
        })
        .send();
    } else {
      const authHeader = req.headers["authorization"];
      const token = authHeader?.split(" ")[1];

      if (!token) {
        throw new Error(
          `Invalid authorization header value, expected Bearer <token>, received ${authHeader}`
        );
      }

      const authData = await verifyToken(token, req);

      if (!authData) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // @ts-expect-error - we're monkey patching this on purpose
      req.auth = authData;
    }

    next();
  };
}

/**
 * Express middleware that enforces authentication for MCP requests and automatically verifies the OAuth access token using Clerk.
 * @example
 * ```ts
 * const server = new McpServer({
 *   name: "test-server",
 *   version: "0.0.1",
 * });
 *
 * // define server tools, resources, etc...
 *
 * app.get("/mcp", mcpAuthClerk, streamableHttpHandler(server));
 * ```
 */
export async function mcpAuthClerk(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  (
    await mcpAuth(async (_, req: express.Request) => {
      const authData = await getAuth(req, { acceptsToken: "oauth_token" });

      if (!authData.isAuthenticated) return false;
      return authData;
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
  properties?: Record<string, any>;
}) {
  return async (req: express.Request, res: express.Response) => {
    const origin = getOrigin(req);

    const metadata = generateProtectedResourceMetadata({
      authServerUrl,
      resourceUrl: origin,
      properties,
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
 *   "/.well-known/oauth-protected-resource",
 *   protectedResourceHandlerClerk
 * );
 * ```
 */
export async function protectedResourceHandlerClerk(
  req: express.Request,
  res: express.Response
) {
  const origin = getOrigin(req);

  const metadata = generateClerkProtectedResourceMetadata({
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
    resourceUrl: origin,
  });

  res.json(metadata);
}

function getOrigin(req: express.Request) {
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

/**
 * An express handler that will handle MCP requests using the streamable http
 * transport, given an MCP server object from the MCP SDK.
 * @param server - The MCP server object from the MCP SDK
 * @example
 * ```ts
 * const server = new McpServer({
 *   name: "test-server",
 *   version: "0.0.1",
 * });
 *
 * // define server tools, resources, etc...
 *
 * app.get("/mcp", streamableHttpHandler(server));
 * ```
 */
export function streamableHttpHandler(server: McpServer) {
  return async (req: express.Request, res: express.Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);
  };
}
