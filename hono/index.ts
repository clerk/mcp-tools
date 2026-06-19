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
  verifyClerkToken,
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

export function mcpAuth(
  verifyToken: (token: string, c: Context) => Promise<AuthInfo | undefined>,
): MiddlewareHandler {
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

    c.set('mcpAuth', authData);
    await next();
  };
}

export const mcpAuthClerk = mcpAuth(async (token, c) => {
  const authData = getAuth(c, { acceptsToken: 'oauth_token' });
  if (!authData.isAuthenticated) return undefined;
  return verifyClerkToken(authData, token);
});

export function streamableHttpHandler(server: McpServer) {
  return async (c: Context) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const req = c.req.raw;
    let response: Response;
    try {
      response = await transport.handleRequest(req, {
        authInfo: c.get('mcpAuth'),
      });
    } catch (error) {
      await transport.close();
      throw error;
    }

    if (!response.body) {
      await transport.close();
      return response;
    }

    // Pipe the body through a TransformStream so transport.close() is called
    // only after the response stream is fully consumed, not before.
    const { readable, writable } = new TransformStream();
    response.body.pipeTo(writable).finally(() => transport.close());
    return new Response(readable, { status: response.status, headers: response.headers });
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
