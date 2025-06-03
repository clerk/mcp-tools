import { type NextRequest } from "next/server";
import { completeAuthWithCode, type McpClientStore } from "../client";
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
} from "../server";

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
 */
export function protectedResourceHandlerClerk(publishableKey: string) {
  return (req: Request) => {
    const origin = new URL(req.url).origin;

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: origin,
    });

    return Response.json(metadata, {
      headers: {
        "Cache-Control": "max-age=3600",
        "Content-Type": "application/json",
      },
    });
  };
}

/**
 * OAuth 2.0 Protected Resource Metadata endpoint based on RFC 9728
 * @see https://datatracker.ietf.org/doc/html/rfc9728
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
      headers: {
        "Cache-Control": "max-age=3600",
        "Content-Type": "application/json",
      },
    });
  };
}

export function authServerMetadataHandlerClerk(publishableKey: string) {
  return async () => {
    const metadata = await fetchClerkAuthorizationServerMetadata({
      publishableKey,
    });

    return Response.json(metadata, {
      headers: {
        "Cache-Control": "max-age=3600",
        "Content-Type": "application/json",
      },
    });
  };
}

/**
 * This is likely going to be moved into vercel's MCP adapter library soon
 * @param handler - vercel mcp adapter handler function
 * @param verifyToken - function called with token and request, expects to get back a boolean indicating if the token is valid
 * @returns a vercel mcp adapter handler function
 */
export function createMcpAuthHandler(
  handler: (req: Request) => Promise<Response>,
  verifyToken: (token: string, req: Request) => Promise<boolean>
) {
  return async (req: Request) => {
    const origin = new URL(req.url).origin;

    if (!req.headers.get("Authorization")) {
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata=${origin}/.well-known/oauth-protected-resource`,
        },
      });
    } else {
      const authHeader = req.headers.get("Authorization");
      const token = authHeader?.split(" ")[1];

      if (!token) {
        throw new Error(
          `Invalid authorization header value, expected Bearer <token>, received ${authHeader}`
        );
      }

      const isAuthenticated = await verifyToken(token, req);

      if (!isAuthenticated) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    return handler(req);
  };
}
