import { clerkClient } from '@clerk/express';
import { requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type CreateMcpHandlerOptions,
  type McpServerFactory,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type express from 'express';
import {
  createClerkOAuthTokenVerifier,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  type ClerkClientWithOAuthAccessTokens,
} from '../server';

type RequestTokenVerifier = (
  token: string,
  request: express.Request,
) => Promise<AuthInfo | undefined>;

export interface McpAuthOptions {
  requiredScopes?: string[];
  resourceMetadataUrl?: string;
}

export interface ClerkMcpAuthOptions extends McpAuthOptions {
  clerkClient?: ClerkClientWithOAuthAccessTokens;
}

export function mcpAuth(
  verifier: OAuthTokenVerifier | RequestTokenVerifier,
  options: McpAuthOptions = {},
): express.RequestHandler {
  return (request, response, next) => {
    const middleware = requireBearerAuth({
      verifier: toOAuthTokenVerifier(verifier, request),
      requiredScopes: options.requiredScopes,
      resourceMetadataUrl:
        options.resourceMetadataUrl ??
        getOAuthProtectedResourceMetadataUrl(getRequestUrl(request)).toString(),
    });
    return middleware(request, response, next);
  };
}

export function mcpAuthClerk(options: ClerkMcpAuthOptions = {}): express.RequestHandler {
  const verifier = createClerkOAuthTokenVerifier(
    (options.clerkClient ?? clerkClient).idPOAuthAccessToken,
  );
  return mcpAuth(verifier, options);
}

export function protectedResourceHandler({
  authServerUrl,
  properties,
}: {
  authServerUrl: string;
  properties?: Record<string, unknown>;
}) {
  return (request: express.Request, response: express.Response) => {
    const metadata = generateProtectedResourceMetadata({
      authServerUrl,
      resourceUrl: getResourceUrl(request),
      properties,
    });

    response.json(metadata);
  };
}

export async function authServerMetadataHandlerClerk(
  _: express.Request,
  response: express.Response,
) {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
  }

  const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey });
  response.json(metadata);
}

export function protectedResourceHandlerClerk(properties?: Record<string, unknown>) {
  return (request: express.Request, response: express.Response) => {
    const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
    }

    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: getResourceUrl(request),
      properties,
    });

    response.json(metadata);
  };
}

export function streamableHttpHandler(
  factory: McpServerFactory,
  options?: CreateMcpHandlerOptions,
): express.RequestHandler {
  const nodeHandler = toNodeHandler(createMcpHandler(factory, options));

  return async (request, response) => {
    await nodeHandler(request, response, request.body);
  };
}

function toOAuthTokenVerifier(
  verifier: OAuthTokenVerifier | RequestTokenVerifier,
  request: express.Request,
): OAuthTokenVerifier {
  if (typeof verifier !== 'function') {
    return verifier;
  }

  return {
    async verifyAccessToken(token: string) {
      const authInfo = await verifier(token, request);
      if (!authInfo) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid');
      }
      return authInfo;
    },
  };
}

function getRequestUrl(request: express.Request): URL {
  return new URL(`${request.protocol}://${request.get('host')}${request.originalUrl}`);
}

function getResourceUrl(request: express.Request): string {
  const url = getRequestUrl(request);
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
