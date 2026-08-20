import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo, McpServerFactory } from '@modelcontextprotocol/server';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  invalidOriginResponseBody,
  type StreamableHttpHandlerOptions,
  validateOrigin,
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
  // Imported lazily so apps using only the custom mcpAuth path don't need
  // the optional @clerk/hono peer installed.
  const { getAuth } = await import('@clerk/hono');

  const authData = getAuth(c, { acceptsToken: 'oauth_token' });
  if (!authData.isAuthenticated) return undefined;
  return verifyClerkToken(authData, token);
});

/**
 * Requests carrying an `Origin` header are rejected with a 403 unless the
 * origin's hostname is localhost-class (`localhost`, `127.0.0.1`, `[::1]`)
 * or listed in `options.allowedOrigins`, protecting browser-reachable
 * servers against DNS rebinding (the MCP spec requires servers to validate
 * Origin). Non-browser clients send no Origin and are unaffected.
 */
export function streamableHttpHandler(
  createServer: McpServerFactory,
  options?: StreamableHttpHandlerOptions,
): (c: Context) => Response | Promise<Response> {
  const handler = createMcpHandler(createServer);

  return (c: Context) => {
    const origin = validateOrigin({
      originHeader: c.req.header('origin'),
      allowedOrigins: options?.allowedOrigins,
    });

    if (!origin.ok) {
      return c.json(invalidOriginResponseBody(origin.message), { status: 403 });
    }

    return handler.fetch(c.req.raw, { authInfo: c.get('mcpAuth') });
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
