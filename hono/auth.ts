import { createClerkClient } from "@clerk/backend";
import { TokenType } from "@clerk/backend/internal";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { env } from "hono/adapter";
import { createMiddleware } from "hono/factory";
import { getPRMUrl } from "./utils.js";
import { verifyClerkToken } from "../server";

/**
 * Hono middleware that enforces authentication for MCP requests using Clerk.
 *
 * Sets an "auth" variable on the request context, which matches the {@link AuthInfo} type from the MCP SDK.
 */
export const mcpAuthClerk = createMiddleware<
  { Variables: { auth: AuthInfo } }
>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const [type, token] = authHeader?.split(" ") || [];
  const bearerToken = type?.toLowerCase() === "bearer" ? token : undefined;

  // Return 401 with proper www-authenticate header if no authorization is provided
  if (!bearerToken) {
    // Get the resource metadata url for the protected resource
    // We return this in the `WWW-Authenticate` header so the MCP client knows where to find the protected resource metadata
    const resourceMetadataUrl = getPRMUrl(c.req.raw);
    c.header(
      "WWW-Authenticate",
      // NOTE - The mcp sdk also adds `error` and `error_description` to this header as well, depending on the error
      //        see: https://github.com/modelcontextprotocol/typescript-sdk/blob/b28c297184cb0cb64611a3357d6438dd1b0824c6/src/server/auth/middleware/bearerAuth.ts#L76C1-L95C8
      `Bearer resource_metadata="${resourceMetadataUrl}"`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const secretKey = (env(c)?.CLERK_SECRET_KEY || "") as string;
    const publishableKey = (env(c)?.CLERK_PUBLISHABLE_KEY || "") as string;

    const clerkClient = createClerkClient({
      secretKey,
      publishableKey,
    });

    const requestState = await clerkClient.authenticateRequest(c.req.raw, {
      secretKey,
      publishableKey,
      acceptsToken: TokenType.OAuthToken,
    });

    // This is the result of the authenticateRequest call, with the `TokenType.OAuthToken` type
    const auth = requestState.toAuth();

    const authInfo = verifyClerkToken(auth, token);

    // Require valid auth for this endpoint
    if (!authInfo) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Attach auth to Request and Hono context for downstream handlers
    c.set("auth", authInfo);

    await next();
  } catch (error) {
    console.error("Unexpected mcp auth middleware error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
