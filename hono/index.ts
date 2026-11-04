import { getAuth } from '@clerk/hono';
import type { MachineAuthObject } from '@clerk/backend';
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
import {
  type McpAuthClerkOptions,
  resolveMcpAuthClerkOptions,
  tokenMatchesAudience,
  withResourceMetadataUrl,
} from '../mcp-auth-options';

export type { McpAuthClerkOptions };

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

/**
 * Hono middleware that verifies the OAuth access token using Clerk, with no audience check. Prefer
 * `createMcpAuthClerk`, which checks the audience and sets `resourceMetadataUrl`.
 */
export const mcpAuthClerk = mcpAuth(async (token, c) => {
  const authData = getAuth(c, { acceptsToken: 'oauth_token' });
  if (!authData.isAuthenticated) return undefined;
  return verifyClerkToken(authData, token);
});

/**
 * Creates Hono middleware that enforces authentication for MCP requests: it verifies the OAuth access token using
 * Clerk, refuses a token that was not issued for `audience` with `401`, and stores auth info that carries
 * `resourceMetadataUrl` as `c.get('mcpAuth')`. Apply `clerkMiddleware()` first, as for `mcpAuthClerk`. Without an
 * audience check, any OAuth token that your Clerk instance issued could call your tools. Throws a `Clerk error:`
 * message when `audience` is missing or empty.
 * The audience is also checked here for JWT access tokens (the `aud` claim must overlap `audience`), so an older Clerk
 * SDK that ignores the `audience` option still cannot accept a token for another resource. Opaque tokens have no `aud`
 * to read here, so only Clerk's check covers them, and that needs `@clerk/backend` 3.19.0 or later.
 * @example
 * ```ts
 * const mcpHandler = createMcpHandler(createServer);
 *
 * app.use("/mcp", clerkMiddleware());
 * app.all("/mcp", createMcpAuthClerk({ audience: "https://mcp.example.com/mcp" }), (c) =>
 *   mcpHandler.fetch(c.req.raw, { authInfo: c.get("mcpAuth") }),
 * );
 * ```
 */
export function createMcpAuthClerk(options: McpAuthClerkOptions): MiddlewareHandler {
  const { audience, resourceMetadataUrl } = resolveMcpAuthClerkOptions(options);
  return mcpAuth(async (token, c) => {
    const clerk = c.get('clerk');
    if (!clerk) {
      throw new Error(
        'Clerk error: createMcpAuthClerk needs clerkMiddleware() to run before it, so that Clerk is set up for this request',
      );
    }
    const requestState = await clerk.authenticateRequest(c.req.raw, {
      acceptsToken: 'oauth_token',
      audience,
    });
    const authData = requestState.toAuth() as unknown as MachineAuthObject<'oauth_token'>;
    // The same token that Clerk verified and that goes into the auth info.
    const authInfo = tokenMatchesAudience(token, audience)
      ? verifyClerkToken(authData, token)
      : undefined;
    return authInfo && withResourceMetadataUrl(authInfo, resourceMetadataUrl ?? getPRMUrl(c));
  });
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

function unauthorized(c: Context) {
  return c.json(
    { error: 'Unauthorized' },
    {
      status: 401,
      headers: { 'WWW-Authenticate': `Bearer resource_metadata=${getPRMUrl(c)}` },
    },
  );
}
