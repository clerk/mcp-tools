import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo, McpServerFactory } from '@modelcontextprotocol/server';
import type { NextRequest } from 'next/server';
import { type McpClientStore, completeAuthWithCode } from '../client';
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  verifyClerkToken,
} from '../server';

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
}): (req: NextRequest) => Promise<Response | ReturnType<typeof callback>> {
  return async (req: NextRequest): Promise<Response | ReturnType<typeof callback>> => {
    const qs = req.nextUrl.searchParams;
    const code = qs.get('code');
    const state = qs.get('state');
    const iss = qs.get('iss') ?? undefined;

    if (!state) {
      return Response.json({ error: 'State missing' }, { status: 400 });
    }

    if (!code) {
      return Response.json({ error: 'Authorization code missing' }, { status: 400 });
    }

    // this function will run the state param check internally; iss, when
    // present, is validated against the recorded issuer (RFC 9207)
    const res = await completeAuthWithCode({ state, code, iss, store });

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
}): (req: Request) => Response {
  return (req: Request): Response => {
    const origin = new URL(req.url).origin;

    const metadata = generateProtectedResourceMetadata({
      authServerUrl: authServerUrl,
      resourceUrl: origin,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          'Cache-Control': 'max-age=3600',
          'Content-Type': 'application/json',
        },
        corsHeaders,
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
  properties?: Record<string, unknown>,
): (req: Request) => Response {
  return (req: Request): Response => {
    const origin = new URL(req.url).origin;

    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: origin,
      properties,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          'Cache-Control': 'max-age=3600',
          'Content-Type': 'application/json',
        },
        corsHeaders,
      ),
    });
  };
}

/**
 * OAuth 2.0 Authorization Server Metadata endpoint based on RFC 8414
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */
export function authServerMetadataHandlerClerk(): () => Promise<Response> {
  return async (): Promise<Response> => {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = await fetchClerkAuthorizationServerMetadata({
      publishableKey,
    });

    return Response.json(metadata, {
      headers: Object.assign(
        {
          'Cache-Control': 'max-age=3600',
          'Content-Type': 'application/json',
        },
        corsHeaders,
      ),
    });
  };
}

/**
 * CORS options request handler for OAuth metadata endpoints. Necessary for MCP
 * clients that operate in web browsers.
 */
export function metadataCorsOptionsRequestHandler(): () => Response {
  return (): Response => {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  };
}

/**
 * A Next.js route handler that will handle MCP requests using the streamable
 * http transport, given a factory that returns an MCP server object from the
 * MCP SDK. The factory is called once per request — v2 transports are
 * per-request and stateless.
 *
 * If a `verifyToken` function is provided, requests must carry a valid
 * `Authorization: Bearer <token>` header; the resulting auth info is passed
 * through to the MCP server handlers.
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
 * const handler = streamableHttpHandler(createServer, {
 *   verifyToken: async (token) => {
 *     const authData = await auth({ acceptsToken: "oauth_token" });
 *     if (!authData.isAuthenticated) return undefined;
 *     return verifyClerkToken(authData, token);
 *   },
 * });
 *
 * export { handler as GET, handler as POST };
 * ```
 */
export function streamableHttpHandler(
  createServer: McpServerFactory,
  options?: {
    verifyToken?: (token: string, req: Request) => Promise<AuthInfo | undefined>;
  },
): (req: Request) => Promise<Response> {
  const handler = createMcpHandler(createServer);
  const verifyToken = options?.verifyToken;

  return async (req: Request): Promise<Response> => {
    if (!verifyToken) return handler.fetch(req);

    const authHeader = req.headers.get('authorization');

    if (!authHeader) {
      return unauthorized(req);
    }

    const [scheme, token, ...rest] = authHeader.trim().split(/\s+/);

    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
      return unauthorized(req);
    }

    const authInfo = await verifyToken(token, req);

    if (!authInfo) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return handler.fetch(req, { authInfo });
  };
}

function unauthorized(req: Request) {
  const url = new URL(req.url);
  return Response.json(
    { error: 'Unauthorized' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata=${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
      },
    },
  );
}

// re-export the verifyClerkToken function for convenience
export { verifyClerkToken };
