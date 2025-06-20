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
