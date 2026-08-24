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

export interface StreamableHttpHandlerOptions {
  auth?: BearerAuthOptions;
  mcp?: CreateMcpHandlerOptions;
}

export function completeOAuthHandler({
  store,
  callback,
}: {
  store: McpClientStore;
  callback: (params: Awaited<ReturnType<typeof completeAuthWithCode>>) => void;
}): (request: NextRequest) => Promise<Response | ReturnType<typeof callback>> {
  return async (request: NextRequest): Promise<Response | ReturnType<typeof callback>> => {
    const query = request.nextUrl.searchParams;
    const state = query.get('state');

    if (!state) {
      return Response.json({ error: 'State missing' }, { status: 400 });
    }

    const result = await completeAuthWithCode({ callbackParams: query, store });

    return callback(result);
  };
}

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

export function metadataCorsOptionsRequestHandler(): () => Response {
  return (): Response => {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  };
}

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
