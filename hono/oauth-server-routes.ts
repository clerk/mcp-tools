import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "hono/adapter";
import { createFactory } from "hono/factory";
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
} from "../server";
import { getResourceUrl } from "./utils.js";

/**
 * Create middleware to handle CORS for the OAuth endpoints,
 * this is useful for testing auth from a browser-based MCP client,
 * or the MCP inspector (`bunx @modelcontextprotocol/inspector`)
 *
 * @note We convert the CORS headers that we get from the @clerk/mcp-tools library
 *       into a format that Hono middleware can understand
 *
 * @see https://github.com/clerk/mcp-tools/blob/main/server.ts
 */
export const oauthCorsMiddleware = cors({
  origin: corsHeaders["Access-Control-Allow-Origin"],
  // HACK - split the comma-separated list of methods into an array
  allowMethods: corsHeaders["Access-Control-Allow-Methods"].split(","),
  allowHeaders: [corsHeaders["Access-Control-Allow-Headers"]],
  maxAge: parseInt(corsHeaders["Access-Control-Max-Age"], 10),
});

/**
 * An Hono handler that will return OAuth protected resource metadata if you're using Clerk.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-4.1
 * @example
 * ```ts
 * app.on(
 *   ["GET", "OPTIONS"],
 *   "/.well-known/oauth-protected-resource",
 *   oauthCorsMiddleware,
 *   protectedResourceHandlerClerk()
 * );
 * ```
 */
export const protectedResourceHandlerClerk = (
  properties?: Record<string, unknown>
) => {
  const factory = createFactory();
  const handlers = factory.createHandlers((c) => {
    const publishableKey = env(c)?.CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      console.error(
        "CLERK_PUBLISHABLE_KEY is not set for OAuth Authorization Server endpoint",
      );
      return c.json({ error: "Internal Server Error" }, 500);
    }

    const resourceUrl = getResourceUrl(c.req.raw);

    const result = generateClerkProtectedResourceMetadata({
      publishableKey: publishableKey as string,
      resourceUrl,
      properties,
    });

    return c.json(result);
  })
  return handlers[0];
}

const authServerFactory = createFactory();
const authServerHandlers = authServerFactory.createHandlers(async (c) => {
  const publishableKey = env(c)?.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    console.error(
      "CLERK_PUBLISHABLE_KEY is not set for OAuth Authorization Server endpoint",
    );
    return c.json({ error: "Internal Server Error" }, 500);
  }

  // If CLERK_PUBLISHABLE_KEY is misconfigured, this will result in a 500
  const result = await fetchClerkAuthorizationServerMetadata({
    publishableKey: publishableKey as string,
  });

  return c.json(result);
});

/**
 * Implement the OAuth Authorization Server endpoint
 *
 * @note - In this case, Clerk is the authorization server, so we shouldn't *need* to implement this;
 *         however, in earlier versions of the MCP spec (prior to 2025-06-18), this route was expected/required,
 *         so we implement it for backwards compatibility with clients.
 */
export const authServerMetadataHandlerClerk = authServerHandlers[0];
