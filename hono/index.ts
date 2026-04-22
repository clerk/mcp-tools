import { getAuth } from '@clerk/hono';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context, MiddlewareHandler, Next } from 'hono';
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
    const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
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
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
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
    const prmUrl = getPRMUrl(c);

    if (!c.req.header('authorization')) {
      return c.json(
        { error: 'Unauthorized' },
        {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata=${prmUrl}` },
        },
      );
    }

    const authHeader = c.req.header('authorization')!;
    const token = authHeader.split(' ')[1];

    if (!token) {
      throw new Error(
        `Invalid authorization header value, expected Bearer <token>, received ${authHeader}`,
      );
    }

    const authData = await verifyToken(token, c);

    if (!authData) {
      return c.json({ error: 'Unauthorized' }, { status: 401 });
    }

    c.set('mcpAuth', authData);
    await next();
  };
}

export async function mcpAuthClerk(c: Context, next: Next): Promise<Response | void> {
  return mcpAuth(async (token, ctx) => {
    const authData = getAuth(ctx, { acceptsToken: 'oauth_token' });
    if (!authData.isAuthenticated) return undefined;
    return verifyClerkToken(authData, token);
  })(c, next);
}

export function streamableHttpHandler(server: McpServer) {
  return async (c: Context) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const req = c.req.raw;
    const accept = req.headers.get('accept') ?? '';
    const needsAccept =
      !accept.includes('application/json') || !accept.includes('text/event-stream');
    const forwardedReq = needsAccept
      ? new Request(req, {
          headers: new Headers({
            ...Object.fromEntries(req.headers.entries()),
            accept: 'application/json, text/event-stream',
          }),
        })
      : req;
    return transport.handleRequest(forwardedReq, { authInfo: c.get('mcpAuth') as AuthInfo | undefined });
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
