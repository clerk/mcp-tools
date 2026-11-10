import type { ClerkHonoVariables } from '@clerk/hono/types';
import type { AuthInfo, McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  type ClerkOAuthClient,
  type McpAuthClerkOptions,
  type McpAuthFailure,
  type McpAuthOptions,
  type McpResourceUrl,
  McpAuthError,
  McpTokenVerificationError,
  assertMcpAuthClerkOptions,
  assertMcpAuthOptions,
  assertTransportClass,
  audienceFor,
  authenticateBearer,
  resourceFromMetadataUrl,
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
    /** Why `mcpAuth` answered this request with a 401 or 403 challenge or a 421, when it did. */
    mcpAuthFailure: McpAuthFailure | undefined;
  }
}

export {
  type ClerkOAuthClient,
  McpAuthError,
  type McpAuthClerkOptions,
  type McpAuthFailure,
  type McpAuthOptions,
  type McpResourceUrl,
  type McpServerLike,
  McpTokenVerificationError,
  type StreamableHttpTransportClass,
};

/**
 * The part of a web-standard streamable HTTP server transport, such as `WebStandardStreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, that `streamableHttpHandler` uses.
 */
export interface WebStandardStreamableHttpTransport {
  /**
   * Handles one MCP request.
   * @param request - The incoming request
   * @param options - The auth info of the request's verified token, if any
   * @returns The response to send
   */
  handleRequest(request: Request, options: { authInfo: AuthInfo | undefined }): Promise<Response>;
  /**
   * Closes the transport.
   * @returns A promise that resolves once the transport is closed
   */
  close(): Promise<void>;
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
      resourceUrl: resourceFromMetadataUrl(c.req.url),
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
      resourceUrl: resourceFromMetadataUrl(c.req.url),
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
      requestUrl: c.req.url,
      resourceUrl: options?.resourceUrl,
      requiredScopes: options?.requiredScopes,
      challengeScopes: options?.challengeScopes,
      verifyToken: (token) => verifyToken(token, c),
    });

    if (!result.ok) {
      c.set('mcpAuthFailure', result.failure);
      return c.json(
        { error: result.error },
        {
          status: result.status,
          headers: result.challenge ? { 'WWW-Authenticate': result.challenge } : undefined,
        },
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
 * `publishableKey` to keep `clerkMiddleware()` off the MCP route, which otherwise verifies each token a second time. A
 * client from `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check.
 * @returns The middleware. A missing or rejected token gets a 401 challenge, and a token without `requiredScopes` gets
 * a 403 challenge.
 */
export function mcpAuthClerk(
  options: McpAuthClerkOptions & {
    clerkClient?: ClerkOAuthClient | undefined;
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
    return verifyClerkOAuthToken(client, token, audienceFor(options.resourceUrl, c.req.url));
  }, options);
}

/**
 * A Hono handler that serves MCP requests over the streamable HTTP transport, creating a fresh server and transport
 * for each request so that concurrent requests don't share state. It passes on the auth info that `mcpAuth` or
 * `mcpAuthClerk` set.
 * @param createServer - A factory that returns a new MCP server, such as `McpServer` from the MCP SDK
 * @param Transport - The SDK's web-standard transport class, `WebStandardStreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`. It is taken as an argument so that this package
 * never imports the SDK, which only apps serving MCP with this handler need to install.
 * @returns The handler
 * @example
 * ```ts
 * import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
 *
 * app.post(
 *   '/mcp',
 *   mcpAuthClerk({ resourceUrl: 'https://mcp.example.com/mcp' }),
 *   streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
 * );
 * ```
 * @typeParam Transport - The transport the class creates, inferred from the class alone
 * @typeParam Server - The server `createServer` returns. It is a separate type parameter so that `Transport` is not
 * inferred from the SDK's general `Transport` interface, which `McpServer.connect` takes.
 */
export function streamableHttpHandler<
  Transport extends WebStandardStreamableHttpTransport,
  Server extends McpServerLike<Transport>,
>(createServer: () => Server, Transport: StreamableHttpTransportClass<Transport>) {
  assertTransportClass(
    Transport,
    'WebStandardStreamableHTTPServerTransport',
    'webStandardStreamableHttp.js',
  );

  return async (c: Context) => {
    const transport = new Transport({ sessionIdGenerator: undefined });

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
