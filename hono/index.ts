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

/** Bearer-auth options for an MCP route. */
export interface McpAuthOptions {
  /** Scopes that every accepted access token must contain. */
  requiredScopes?: string[];
  /** Protected Resource Metadata URL advertised in bearer challenges. */
  resourceMetadataUrl?: string;
}

/** Clerk bearer-auth options for an MCP route. */
export interface ClerkMcpAuthOptions extends McpAuthOptions {
  /** Clerk client override. By default, uses the client set by `clerkMiddleware()`. */
  clerkClient?: ClerkClientWithOAuthAccessTokens;
}

/**
 * Creates an RFC 9728 Protected Resource Metadata handler.
 *
 * Mount the path suffix that matches the MCP resource path. The handler derives
 * `resource` from the request URL, so this example advertises `https://host/mcp`.
 *
 * @example
 * ```ts
 * app.get(
 *   '/.well-known/oauth-protected-resource/mcp',
 *   protectedResourceHandler({ authServerUrl: 'https://auth.example.com' }),
 * );
 * ```
 */
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

/**
 * Creates Clerk Protected Resource Metadata from `CLERK_PUBLISHABLE_KEY`.
 *
 * @example
 * ```ts
 * app.get(
 *   '/.well-known/oauth-protected-resource/mcp',
 *   protectedResourceHandlerClerk({ scopes_supported: ['mcp:read'] }),
 * );
 * ```
 */
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

/** Serves Clerk Authorization Server Metadata from `CLERK_PUBLISHABLE_KEY`. */
export async function authServerMetadataHandlerClerk(context: Context) {
  const publishableKey = env<ClerkEnv>(context).CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
  }
  const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey });
  return context.json(metadata);
}

/**
 * Requires a valid bearer token and stores its `AuthInfo` as `mcpAuth`.
 *
 * An SDK `OAuthTokenVerifier` is preferred. A request-aware callback remains
 * supported for custom token systems. The default challenge points to the
 * path-aware Protected Resource Metadata URL for the current request.
 *
 * @example
 * ```ts
 * app.use('/mcp', mcpAuth(verifier, { requiredScopes: ['mcp:read'] }));
 * ```
 */
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

/**
 * Requires a Clerk OAuth access token through the client from `clerkMiddleware()`.
 *
 * @example
 * ```ts
 * app.use('/mcp', clerkMiddleware());
 * app.use('/mcp', mcpAuthClerk({ requiredScopes: ['mcp:read'] }));
 * app.all('/mcp', streamableHttpHandler(createServer));
 * ```
 */
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

/**
 * Creates a Hono handler for MCP 2026-07-28 and stateless legacy clients.
 *
 * The factory receives the protocol era, request, and verified auth data. It
 * must return a new server instance for each request.
 *
 * @example
 * ```ts
 * const createServer = () =>
 *   new McpServer({ name: 'support-server', version: '1.0.0' });
 *
 * app.all('/mcp', streamableHttpHandler(createServer));
 * ```
 */
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
