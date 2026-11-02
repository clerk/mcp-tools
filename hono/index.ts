import { getAuth } from '@clerk/hono';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  scopeChallenge,
  type ToolScopes,
  verifyClerkToken,
} from '../server';
import { assertToolScopes } from '../scope-challenge';

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

export function mcpAuth(
  verifyToken: (token: string, c: Context) => Promise<AuthInfo | undefined>,
  options: {
    /** Scopes each tool needs. A `tools/call` for a tool whose scopes the token lacks gets a 403 step-up challenge. */
    toolScopes?: ToolScopes;
  } = {},
): MiddlewareHandler {
  if (options.toolScopes) assertToolScopes('mcpAuth', options.toolScopes);
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('authorization');

    if (!authHeader) {
      return unauthorized(c);
    }

    const [scheme, token, ...rest] = authHeader.trim().split(/\s+/);

    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
      return unauthorized(c);
    }

    const authData = await verifyToken(token, c);

    if (!authData) {
      return c.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (options.toolScopes && c.req.method === 'POST') {
      // A clone, so the transport can still read the request body.
      const body: unknown = await c.req.raw
        .clone()
        .json()
        .catch(() => undefined);
      const challenge = scopeChallenge({
        body,
        authInfo: authData,
        toolScopes: options.toolScopes,
        resourceMetadataUrl: getPRMUrl(c),
      });
      if (challenge) return challenge;
    }

    c.set('mcpAuth', authData);
    await next();
  };
}

export const mcpAuthClerk = mcpAuth(async (token, c) => {
  const authData = getAuth(c, { acceptsToken: 'oauth_token' });
  if (!authData.isAuthenticated) return undefined;
  return verifyClerkToken(authData, token);
});

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

function unauthorized(c: Context) {
  return c.json(
    { error: 'Unauthorized' },
    {
      status: 401,
      headers: { 'WWW-Authenticate': `Bearer resource_metadata=${getPRMUrl(c)}` },
    },
  );
}
