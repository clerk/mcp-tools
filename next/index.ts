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
export function protectedResourceHandlerClerk() {
  return (req: Request) => {
    const origin = new URL(req.url).origin;

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!,
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

export function authServerMetadataHandlerClerk() {
  return async () => {
    const metadata = await fetchClerkAuthorizationServerMetadata({
      publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!,
    });

    return Response.json(metadata, {
      headers: {
        "Cache-Control": "max-age=3600",
        "Content-Type": "application/json",
      },
    });
  };
}
