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

/** Bearer-auth options for an MCP route. */
export interface McpAuthOptions {
  /** Scopes that every accepted access token must contain. */
  requiredScopes?: string[];
  /** Protected Resource Metadata URL advertised in bearer challenges. */
  resourceMetadataUrl?: string;
}

/** Clerk bearer-auth options for an MCP route. */
export interface ClerkMcpAuthOptions extends McpAuthOptions {
  /** Clerk client override. By default, uses the `@clerk/express` client. */
  clerkClient?: ClerkClientWithOAuthAccessTokens;
}

/**
 * Creates Express middleware that requires a valid MCP bearer token.
 *
 * An SDK `OAuthTokenVerifier` is preferred. A request-aware callback remains
 * supported for custom token systems. Successful auth is attached to
 * `request.auth` for the MCP Node adapter.
 *
 * @example
 * ```ts
 * app.all(
 *   '/mcp',
 *   mcpAuth(verifier, { requiredScopes: ['mcp:read'] }),
 *   streamableHttpHandler(createServer),
 * );
 * ```
 */
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

/**
 * Creates bearer-auth middleware backed by Clerk's OAuth access-token API.
 *
 * @example
 * ```ts
 * app.use(express.json());
 * app.all(
 *   '/mcp',
 *   mcpAuthClerk({ requiredScopes: ['mcp:read'] }),
 *   streamableHttpHandler(createServer),
 * );
 * ```
 */
export function mcpAuthClerk(options: ClerkMcpAuthOptions = {}): express.RequestHandler {
  const verifier = createClerkOAuthTokenVerifier(
    (options.clerkClient ?? clerkClient).idPOAuthAccessToken,
  );
  return mcpAuth(verifier, options);
}

/**
 * Creates an RFC 9728 Protected Resource Metadata handler.
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
  return (request: express.Request, response: express.Response) => {
    const metadata = generateProtectedResourceMetadata({
      authServerUrl,
      resourceUrl: getResourceUrl(request),
      properties,
    });

    response.json(metadata);
  };
}

/** Serves Clerk Authorization Server Metadata from `CLERK_PUBLISHABLE_KEY`. */
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

/**
 * Creates an Express handler for MCP 2026-07-28 and stateless legacy clients.
 *
 * The factory returns an isolated server for each request. Mount `express.json()`
 * before this handler so the Node adapter can use the parsed request body.
 *
 * @example
 * ```ts
 * const createServer = () =>
 *   new McpServer({ name: 'support-server', version: '1.0.0' });
 *
 * app.use(express.json());
 * app.all('/mcp', streamableHttpHandler(createServer));
 * ```
 */
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
