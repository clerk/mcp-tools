import { type NextRequest } from "next/server";
import { completeAuthWithCode, type McpClientStore } from "../client";
import { generateProtectedResourceMetadata } from "../server";

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

    // TODO: set some sort of "completed auth" flag in the store here

    return callback(res);
  };
}

/**
 * OAuth 2.0 Protected Resource Metadata endpoint based on RFC 9728
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 */
export function protectedResourceHandler(publishableKey: string) {
  return (req: Request) => {
    const origin = new URL(req.url).origin;

    const metadata = generateProtectedResourceMetadata(publishableKey, origin);

    return Response.json(metadata, {
      headers: {
        "Cache-Control": "max-age=3600",
        "Content-Type": "application/json",
      },
    });
  };
}

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
