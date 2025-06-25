import type { MachineAuthObject } from "@clerk/backend";
import type { NextRequest } from "next/server";
import { type McpClientStore, completeAuthWithCode } from "../client";
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
} from "../server";

/**
 * A request handler intended to be run at the OAuth callback endpoint.
 * It will complete the OAuth flow by exchanging the authorization code for a
 * token, store the token, then call the passed in callback fn when complete.
 * @param store - The client store to use for storing the token.
 * @param callback - A function to call once the OAuth flow is complete.
 */
export function completeOAuthHandler({
  store,
  callback,
}: {
  store: McpClientStore;
  callback: (params: Awaited<ReturnType<typeof completeAuthWithCode>>) => void;
}) {
  return async (req: NextRequest) => {
    const qs = req.nextUrl.searchParams;
    const code = qs.get("code");
    const state = qs.get("state");

    if (!state) {
      return Response.json({ error: "State missing" }, { status: 400 });
    }

    if (!code) {
      return Response.json(
        { error: "Authorization code missing" },
        { status: 400 }
      );
    }

    // this function will run the state param check internally
    const res = await completeAuthWithCode({ state, code, store });

    return callback(res);
  };
}

/**
 * OAuth 2.0 Protected Resource Metadata endpoint based on RFC 9728
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 * @param authServerUrl - The URL of the OAuth 2.0 Authorization Server.
 */
export function protectedResourceHandler({
  authServerUrl,
}: {
  authServerUrl: string;
}) {
  return (req: Request) => {
    const origin = new URL(req.url).origin;

    const metadata = generateProtectedResourceMetadata({
      authServerUrl: authServerUrl,
      resourceUrl: origin,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          "Cache-Control": "max-age=3600",
          "Content-Type": "application/json",
        },
        corsHeaders
      ),
    });
  };
}

/**
 * OAuth 2.0 Protected Resource Metadata endpoint based on RFC 9728
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 *
 */
export function protectedResourceHandlerClerk(
  properties?: Record<string, unknown>
) {
  return (req: Request) => {
    const origin = new URL(req.url).origin;

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!,
      resourceUrl: origin,
      properties,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          "Cache-Control": "max-age=3600",
          "Content-Type": "application/json",
        },
        corsHeaders
      ),
    });
  };
}

/**
 * OAuth 2.0 Authorization Server Metadata endpoint based on RFC 8414
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */
export function authServerMetadataHandlerClerk() {
  return async () => {
    const metadata = await fetchClerkAuthorizationServerMetadata({
      publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          "Cache-Control": "max-age=3600",
          "Content-Type": "application/json",
        },
        corsHeaders
      ),
    });
  };
}

/**
 * CORS options request handler for OAuth metadata endpoints. Necessary for MCP
 * clients that operate in web browsers.
 */
export function metadataCorsOptionsRequestHandler() {
  return () => {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  };
}

/**
 * Helper to be used within the "verifyToken" function in the withMcpAuth()
 * handler from @vercel/mcp-adapter.
 * @param auth - result of the auth() function from @clerk/nextjs/server, called with acceptsToken: 'oauth_token'
 * @param token - the oauth access token, passed through withMcpAuth()
 * @example
 * ```ts
 * import { experimental_withMcpAuth as withMcpAuth, } from "@vercel/mcp-adapter";
 * import { verifyClerkToken } from "@clerk/mcp-tools/next";
 *
 * const handler = createMcpHandler((server) => {
 *   // define your tools, resources, etc
 * });
 *
 * const authHandler = withMcpAuth(
 *   handler,
 *   async (_, token) => {
 *     const clerkAuth = await auth({ acceptsToken: "oauth_token" });
 *     return verifyClerkToken(clerkAuth, token);
 *   },
 *   { required: true }
 * );
 *
 * export { authHandler as GET, authHandler as POST };
 * ```
 */
export async function verifyClerkToken(
  auth: MachineAuthObject<"oauth_token">,
  token: string | undefined
) {
  if (!token) return undefined;

  if (!auth.isAuthenticated) {
    console.error("Invalid OAuth access token");
    return undefined;
  }

  if (auth.tokenType !== "oauth_token") {
    throw new Error(
      "the auth() function must be called with acceptsToken: 'oauth_token'"
    );
  }

  // None of these _should_ ever happen
  if (!auth.clientId) {
    console.error("Clerk error: No clientId returned from auth()");
    return undefined;
  }

  if (!auth.scopes) {
    console.error("Clerk error: No scopes returned from auth()");
    return undefined;
  }

  if (!auth.userId) {
    console.error("Clerk error: No userId returned from auth()");
    return undefined;
  }

  return {
    token,
    scopes: auth.scopes,
    clientId: auth.clientId,
    extra: { userId: auth.userId },
  };
}
