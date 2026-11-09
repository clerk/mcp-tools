import type { ClerkClient } from '@clerk/backend';
import type { ClerkHonoVariables } from '@clerk/hono/types';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  type McpAuthClerkOptions,
  type McpAuthOptions,
  assertMcpAuthClerkOptions,
  assertMcpAuthOptions,
  authenticateBearer,
  resourceMetadataUrlFor,
  verifyClerkOAuthToken,
} from '../bearer-auth';
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
} from '../server';

declare module 'hono' {
  interface ContextVariableMap {
    mcpAuth: AuthInfo;
  }
}

type ClerkEnv = {
  CLERK_PUBLISHABLE_KEY?: string;
};

export function protectedResourceHandler({
  authServerUrl,
  properties,
}: {
  authServerUrl: string;
  properties?: Record<string, unknown>;
}) {
  return (c: Context) => {
    const metadata = generateProtectedResourceMetadata({
      authServerUrl,
      resourceUrl: getResourceUrl(c),
      properties,
    });
    return c.json(metadata);
  };
}

export function protectedResourceHandlerClerk(properties?: Record<string, unknown>) {
  return (c: Context) => {
    const publishableKey = env<ClerkEnv>(c).CLERK_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
    }
    const metadata = generateClerkProtectedResourceMetadata({
      publishableKey,
      resourceUrl: getResourceUrl(c),
      properties,
    });
    return c.json(metadata);
  };
}

export async function authServerMetadataHandlerClerk(c: Context) {
  const publishableKey = env<ClerkEnv>(c).CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY environment variable is required');
  }
  const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey });
  return c.json(metadata);
}

/**
 * Hono middleware that enforces authentication for MCP requests.
 * @param verifyToken - Verifies a token and returns the auth data, or `undefined` to reject it
 * @param options - The public `resourceUrl` of this endpoint and the `requiredScopes` every request needs
 * @returns The middleware. A missing or rejected token gets a 401 challenge, and a token without `requiredScopes` gets
 * a 403 challenge.
 */
export function mcpAuth(
  verifyToken: (token: string, c: Context) => Promise<AuthInfo | undefined>,
  options?: McpAuthOptions,
): MiddlewareHandler {
  assertMcpAuthOptions('mcpAuth', options);

  return async (c: Context, next: Next) => {
    const result = await authenticateBearer({
      authorization: c.req.header('authorization'),
      resourceMetadataUrl: options?.resourceUrl
        ? resourceMetadataUrlFor(options.resourceUrl)
        : getPRMUrl(c),
      requiredScopes: options?.requiredScopes,
      verifyToken: (token) => verifyToken(token, c),
    });

    if (!result.ok) {
      return c.json(
        { error: result.error },
        { status: result.status, headers: { 'WWW-Authenticate': result.challenge } },
      );
    }

    c.set('mcpAuth', result.authInfo);
    await next();
  };
}

/**
 * Hono middleware that enforces authentication for MCP requests and verifies the OAuth access token with Clerk,
 * including that its audience is this endpoint.
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, and the `clerkClient` that verifies tokens. Without `clerkClient`, it uses the client that
 * `clerkMiddleware()` sets, so `clerkMiddleware()` must run first. Pass a client created with both `secretKey` and
 * `publishableKey` to keep `clerkMiddleware()` off the MCP route, which otherwise verifies each token a second time.
 * @returns The middleware. A missing or rejected token gets a 401 challenge, and a token without `requiredScopes` gets
 * a 403 challenge.
 */
export function mcpAuthClerk(
  options: McpAuthClerkOptions & {
    clerkClient?: Pick<ClerkClient, 'authenticateRequest'> | undefined;
  },
): MiddlewareHandler {
  assertMcpAuthClerkOptions(options);

  return mcpAuth((token, c) => {
    const client =
      options.clerkClient ?? (c as Context<{ Variables: ClerkHonoVariables }>).get('clerk');
    if (!client) {
      throw new Error(
        'Clerk error: mcpAuthClerk needs a clerkClient option or clerkMiddleware() to run first',
      );
    }
    return verifyClerkOAuthToken(client, token, options.resourceUrl);
  }, options);
}

export function streamableHttpHandler(createServer: () => McpServer) {
  return async (c: Context) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      const server = createServer();
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw, {
        authInfo: c.get('mcpAuth'),
      });

      if (!response.body) {
        await transport.close();
        return response;
      }

      const { readable, writable } = new TransformStream();
      void response.body
        .pipeTo(writable)
        .finally(() => transport.close())
        .catch(() => undefined);

      return new Response(readable, { status: response.status, headers: response.headers });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  };
}

function getResourceUrl(c: Context): string {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/\.well-known\/oauth-protected-resource\/?/, '');
  return url.toString();
}

function getPRMUrl(c: Context): string {
  const url = new URL(c.req.url);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}
