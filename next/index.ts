import type { ClerkClient } from '@clerk/backend';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { NextRequest } from 'next/server';
import {
  type McpAuthClerkOptions,
  type McpAuthOptions,
  assertMcpAuthClerkOptions,
  assertMcpAuthOptions,
  authenticateBearer,
  resourceMetadataUrlFor,
  verifyClerkOAuthToken,
} from '../bearer-auth';
import { type McpClientStore, completeAuthWithCode } from '../client';
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  requireAdditionalScopes,
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

    if (!state) {
      return Response.json({ error: 'State missing' }, { status: 400 });
    }

    if (!code) {
      return Response.json({ error: 'Authorization code missing' }, { status: 400 });
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
}): (req: Request) => Response {
  return (req: Request): Response => {
    const metadata = generateProtectedResourceMetadata({
      authServerUrl: authServerUrl,
      resourceUrl: getResourceUrl(req),
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
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: getResourceUrl(req),
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
 * A Next.js route handler, such as the one `createMcpHandler` from `mcp-handler` returns.
 */
export type McpRouteHandler = (req: Request) => Response | Promise<Response>;

/**
 * Wraps a Next.js MCP route handler so that every request needs a valid bearer token.
 * @param verifyToken - Verifies a token and returns the auth data, or `undefined` to reject it
 * @param options - The public `resourceUrl` of this endpoint and the `requiredScopes` every request needs
 * @returns A function that wraps the route handler. A missing or rejected token gets a 401 challenge, and a token
 * without `requiredScopes` gets a 403 challenge. Otherwise the auth data is set on `req.auth`, where `mcp-handler`
 * reads it, with `resourceMetadataUrl` added for the SDK's scope challenges.
 * @example
 * ```ts
 * const handler = createMcpHandler((server) => {
 *   // define server tools, resources, etc...
 * });
 *
 * const authHandler = mcpAuth(verifyToken, {
 *   resourceUrl: "https://mcp.example.com/mcp",
 * })(handler);
 *
 * export { authHandler as GET, authHandler as POST };
 * ```
 */
export function mcpAuth(
  verifyToken: (token: string, req: Request) => Promise<AuthInfo | undefined>,
  options?: McpAuthOptions,
): (handler: McpRouteHandler) => (req: Request) => Promise<Response> {
  assertMcpAuthOptions('mcpAuth', options);

  return (handler) => async (req) => {
    const result = await authenticateBearer({
      authorization: req.headers.get('authorization') ?? undefined,
      resourceMetadataUrl: options?.resourceUrl
        ? resourceMetadataUrlFor(options.resourceUrl)
        : getPRMUrl(req),
      requiredScopes: options?.requiredScopes,
      verifyToken: (token) => verifyToken(token, req),
    });

    if (!result.ok) {
      return Response.json(
        { error: result.error },
        { status: result.status, headers: { 'WWW-Authenticate': result.challenge } },
      );
    }

    // `mcp-handler` passes `req.auth` to its transport, as its own `withMcpAuth` does
    (req as Request & { auth?: AuthInfo }).auth = result.authInfo;
    return handler(req);
  };
}

/**
 * Wraps a Next.js MCP route handler so that every request needs an OAuth access token that Clerk verifies, including
 * that its audience is this endpoint.
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, and the `clerkClient` that verifies tokens. It defaults to `clerkClient()` from `@clerk/nextjs/server`.
 * @returns A function that wraps the route handler. A missing or rejected token gets a 401 challenge, and a token
 * without `requiredScopes` gets a 403 challenge. When Clerk cannot verify the token at all, the handler throws, so
 * Next.js answers with a 500 instead of a challenge that would make the client discard a valid token.
 * @example
 * ```ts
 * const authHandler = mcpAuthClerk({
 *   resourceUrl: "https://mcp.example.com/mcp",
 *   requiredScopes: ["profile", "email"],
 * })(handler);
 *
 * export { authHandler as GET, authHandler as POST };
 * ```
 */
export function mcpAuthClerk(
  options: McpAuthClerkOptions & {
    clerkClient?: Pick<ClerkClient, 'authenticateRequest'> | undefined;
  },
): (handler: McpRouteHandler) => (req: Request) => Promise<Response> {
  assertMcpAuthClerkOptions(options);

  return mcpAuth(async (token) => {
    // Imported lazily so that the rest of this entry point works without `@clerk/nextjs`
    const client =
      options.clerkClient ?? (await (await import('@clerk/nextjs/server')).clerkClient());
    return verifyClerkOAuthToken(client, token, options.resourceUrl);
  }, options);
}

// The protected resource metadata URL for the request's own path, used when `resourceUrl` is not set.
function getPRMUrl(req: Request): string {
  const { origin, pathname } = new URL(req.url);
  return `${origin}/.well-known/oauth-protected-resource${pathname}`;
}

// The resource a protected resource metadata route describes: `/mcp` for `/.well-known/oauth-protected-resource/mcp`,
// and the bare origin for the root route.
function getResourceUrl(req: Request): string {
  const { origin, pathname } = new URL(req.url);
  const resourcePath = pathname.replace('/.well-known/oauth-protected-resource', '');
  return `${origin}${resourcePath.replace(/\/$/, '')}`;
}

// re-export the verifyClerkToken function for convenience
export { requireAdditionalScopes, verifyClerkToken };
