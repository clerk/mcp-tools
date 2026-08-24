import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
  type CreateMcpHandlerOptions,
  type McpServerFactory,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type {} from '@clerk/hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  fetchClerkAuthorizationServerMetadata,
  createClerkOAuthTokenVerifier,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  type ClerkClientWithOAuthAccessTokens,
} from '../server';

declare module 'hono' {
  interface ContextVariableMap {
    mcpAuth: AuthInfo;
  }
}

type ClerkEnv = {
  CLERK_PUBLISHABLE_KEY?: string;
};

type ContextTokenVerifier = (token: string, context: Context) => Promise<AuthInfo | undefined>;

export interface McpAuthOptions {
  requiredScopes?: string[];
  resourceMetadataUrl?: string;
}

export interface ClerkMcpAuthOptions extends McpAuthOptions {
  clerkClient?: ClerkClientWithOAuthAccessTokens;
}

export function protectedResourceHandler({
  authServerUrl,
  properties,
}: {
  authServerUrl: string;
  properties?: Record<string, unknown>;
}) {
  return (context: Context) => {
    const metadata = generateProtectedResourceMetadata({
      authServerUrl,
      resourceUrl: getResourceUrl(context.req.url),
      properties,
    });
    return context.json(metadata);
  };
}

export function protectedResourceHandlerClerk(properties?: Record<string, unknown>) {
  return (context: Context) => {
    const publishableKey = env<ClerkEnv>(context).CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
    }
    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: getResourceUrl(context.req.url),
      properties,
    });
    return context.json(metadata);
  };
}

export async function authServerMetadataHandlerClerk(context: Context) {
  const publishableKey = env<ClerkEnv>(context).CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
  }
  const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey });
  return context.json(metadata);
}

export function mcpAuth(
  verifier: OAuthTokenVerifier | ContextTokenVerifier,
  options: McpAuthOptions = {},
): MiddlewareHandler {
  return async (context: Context, next: Next) => {
    const gate = requireBearerAuth({
      verifier: toOAuthTokenVerifier(verifier, context),
      requiredScopes: options.requiredScopes,
      resourceMetadataUrl:
        options.resourceMetadataUrl ??
        getOAuthProtectedResourceMetadataUrl(new URL(context.req.url)).toString(),
    });
    const authInfo = await gate(context.req.raw);

    if (authInfo instanceof Response) {
      return authInfo;
    }

    context.set('mcpAuth', authInfo);
    await next();
  };
}

export function mcpAuthClerk(options: ClerkMcpAuthOptions = {}): MiddlewareHandler {
  return async (context, next) => {
    const clerkClient = options.clerkClient ?? context.get('clerk');
    if (!clerkClient) {
      throw new Error('clerkMiddleware() must run before mcpAuthClerk()');
    }

    return mcpAuth(createClerkOAuthTokenVerifier(clerkClient.idPOAuthAccessToken), options)(
      context,
      next,
    );
  };
}

export function streamableHttpHandler(
  factory: McpServerFactory,
  options?: CreateMcpHandlerOptions,
): MiddlewareHandler {
  const handler = createMcpHandler(factory, options);

  return async (context: Context) => {
    return handler.fetch(context.req.raw, { authInfo: context.get('mcpAuth') });
  };
}

function toOAuthTokenVerifier(
  verifier: OAuthTokenVerifier | ContextTokenVerifier,
  context: Context,
): OAuthTokenVerifier {
  if (typeof verifier !== 'function') {
    return verifier;
  }

  return {
    async verifyAccessToken(token: string) {
      const authInfo = await verifier(token, context);
      if (!authInfo) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid');
      }
      return authInfo;
    },
  };
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
