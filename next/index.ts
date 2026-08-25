import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type BearerAuthOptions,
  type CreateMcpHandlerOptions,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import type { NextRequest } from 'next/server';
import { type McpClientStore, completeAuthWithCode } from '../client';
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
} from '../server';

/** Options for a Next.js MCP route handler. */
export interface StreamableHttpHandlerOptions {
  /** SDK bearer-auth options. Omit only for an intentionally public endpoint. */
  auth?: BearerAuthOptions;
  /** MCP HTTP handler options, including legacy and response-mode settings. */
  mcp?: CreateMcpHandlerOptions;
}

/**
 * Creates a Next.js OAuth callback handler for an MCP client session.
 *
 * The full callback query, including `iss` and OAuth error fields, is passed to
 * the MCP SDK. The callback must return the final HTTP response.
 *
 * @example
 * ```ts
 * export const GET = completeOAuthHandler({
 *   store,
 *   callback: ({ sessionId }) => Response.json({ sessionId }),
 * });
 * ```
 */
export function completeOAuthHandler({
  store,
  callback,
}: {
  store: McpClientStore;
  callback: (
    params: Awaited<ReturnType<typeof completeAuthWithCode>>,
  ) => Response | Promise<Response>;
}): (request: NextRequest) => Promise<Response> {
  return async (request: NextRequest): Promise<Response> => {
    const query = request.nextUrl.searchParams;
    const state = query.get('state');

    if (!state) {
      return Response.json({ error: 'State missing' }, { status: 400 });
    }

    const result = await completeAuthWithCode({ callbackParams: query, store });

    return callback(result);
  };
}

/**
 * Creates an RFC 9728 Protected Resource Metadata route handler.
 *
 * The metadata route suffix must match the MCP resource path.
 *
 * @example
 * ```ts
 * export const GET = protectedResourceHandler({
 *   authServerUrl: 'https://auth.example.com',
 *   properties: { scopes_supported: ['mcp:read'] },
 * });
 * ```
 */
export function protectedResourceHandler({
  authServerUrl,
  properties,
}: {
  authServerUrl: string;
  properties?: Record<string, unknown>;
}): (request: Request) => Response {
  return (request: Request): Response => {
    const metadata = generateProtectedResourceMetadata({
      authServerUrl,
      resourceUrl: getResourceUrl(request.url),
      properties,
    });

    return metadataResponse(metadata);
  };
}

/**
 * Creates Clerk Protected Resource Metadata from
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
 *
 * @example
 * ```ts
 * export const GET = protectedResourceHandlerClerk({
 *   scopes_supported: ['mcp:read'],
 * });
 * ```
 */
export function protectedResourceHandlerClerk(
  properties?: Record<string, unknown>,
): (request: Request) => Response {
  return (request: Request): Response => {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: getResourceUrl(request.url),
      properties,
    });

    return metadataResponse(metadata);
  };
}

/** Serves Clerk Authorization Server Metadata for MCP OAuth discovery. */
export function authServerMetadataHandlerClerk(): () => Promise<Response> {
  return async (): Promise<Response> => {
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
    }

    const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey });
    return metadataResponse(metadata);
  };
}

/** Creates an OPTIONS handler with permissive CORS headers for OAuth metadata. */
export function metadataCorsOptionsRequestHandler(): () => Response {
  return (): Response => {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  };
}

/**
 * Creates a Next.js route handler for MCP 2026-07-28 and stateless legacy clients.
 *
 * The same handler can be exported for every Streamable HTTP method. The server
 * factory receives the protocol era, request, and verified auth data and must
 * return a new server instance for each request.
 *
 * @example
 * ```ts
 * const createServer = () =>
 *   new McpServer({ name: 'support-server', version: '1.0.0' });
 *
 * const verifier = createClerkOAuthTokenVerifier({
 *   verify: async (token) => (await clerkClient()).idPOAuthAccessToken.verify(token),
 * });
 *
 * const handler = streamableHttpHandler(createServer, {
 *   auth: { verifier, requiredScopes: ['mcp:read'] },
 * });
 *
 * export { handler as GET, handler as POST, handler as DELETE };
 * ```
 */
export function streamableHttpHandler(
  factory: McpServerFactory,
  options: StreamableHttpHandlerOptions = {},
): (request: NextRequest) => Promise<Response> {
  const handler = createMcpHandler(factory, options.mcp);

  return async (request: NextRequest): Promise<Response> => {
    if (!options.auth) {
      return handler.fetch(request);
    }

    const gate = requireBearerAuth({
      ...options.auth,
      resourceMetadataUrl:
        options.auth.resourceMetadataUrl ??
        getOAuthProtectedResourceMetadataUrl(new URL(request.url)).toString(),
    });
    const authInfo = await gate(request);

    if (authInfo instanceof Response) {
      return authInfo;
    }

    return handler.fetch(request, { authInfo });
  };
}

function metadataResponse(metadata: unknown): Response {
  return Response.json(metadata, {
    headers: {
      'Cache-Control': 'max-age=3600',
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function getResourceUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const metadataPath = '/.well-known/oauth-protected-resource';

  if (url.pathname === metadataPath || url.pathname === `${metadataPath}/`) {
    url.pathname = '/';
  } else if (url.pathname.startsWith(`${metadataPath}/`)) {
    url.pathname = url.pathname.slice(metadataPath.length);
  }

  url.search = '';
  url.hash = '';
  return url.toString();
}
