import type { ClerkHonoVariables } from '@clerk/hono/types';
import type { AuthInfo, McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  assertMiddlewareAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertServerFactory,
  assertTransportClass,
  authenticateBearer,
  clerkProtectedResourceMetadata,
  clerkTokenVerifier,
  requirePublishableKey,
} from '../bearer-auth';
import { type McpAuthFailure, fetchAuthorizationServerMetadata } from '../server';

declare module 'hono' {
  interface ContextVariableMap {
    mcpAuth: AuthInfo;
    /**
     * Why `mcpAuth` answered this request with a 401 or 403 challenge or a 421, when it did.
     */
    mcpAuthFailure: McpAuthFailure | undefined;
  }
}

// Everything in the core subpath, so a Hono app imports from this subpath alone
export * from '../server';

/**
 * Options for the `mcpAuth` middleware. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as
 * its audience, and `clerkClient` defaults to the client that `clerkMiddleware()` sets. With `verifyToken`, that
 * function verifies each token with the Hono context, `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type McpAuthOptions = MiddlewareAuthOptions<Context>;

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions`, all optional, plus `properties`, so one object
 * can be passed to both. It ignores `clerkClient` and `verifyToken`.
 */
export type ProtectedResourceMetadataOptions =
  SharedProtectedResourceMetadataOptions<McpAuthOptions>;

/**
 * The part of a web-standard streamable HTTP server transport, such as `WebStandardStreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, that `streamableHttpHandler` uses.
 */
interface WebStandardStreamableHttpTransport {
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

/**
 * A Hono handler that serves RFC 9728 protected resource metadata for a Clerk instance, using the publishable key in
 * the `CLERK_PUBLISHABLE_KEY` environment variable. Mount it at the path `mcpAuth`'s challenge points to.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3
 * @param options - The options you give `mcpAuth`, and `properties`, additional metadata such as `resource_name`,
 * which overrides the generated metadata. `resourceUrl` makes the metadata's `resource` the URL `mcpAuth` checks;
 * without it, the `resource` is the URL the metadata route was requested at, without the well-known path.
 * `scopes_supported` lists `requiredScopes` then `challengeScopes`, unless `properties` sets it, and then that list
 * must include each of them.
 * @returns The handler. A request to an origin no listed `resourceUrl` has gets a 421. It throws when
 * `CLERK_PUBLISHABLE_KEY` is not set.
 * @example
 * ```ts
 * app.get(
 *   '/.well-known/oauth-protected-resource/mcp',
 *   protectedResourceMetadataHandler({ resourceUrl: 'https://mcp.example.com/mcp' }),
 * );
 * ```
 */
export function protectedResourceMetadataHandler(options: ProtectedResourceMetadataOptions = {}) {
  assertProtectedResourceMetadataOptions(options);

  return (c: Context) => {
    const publishableKey = requirePublishableKey(env<ClerkEnv>(c).CLERK_PUBLISHABLE_KEY);
    const metadata = clerkProtectedResourceMetadata(options, c.req.url, publishableKey);
    if (!metadata) return c.json({ error: 'misdirected_request' }, 421);
    return c.json(metadata);
  };
}

/**
 * A Hono handler that serves the RFC 8414 authorization server metadata of the Clerk instance named by
 * `CLERK_PUBLISHABLE_KEY`, fetched from its Frontend API on each request.
 * @see https://datatracker.ietf.org/doc/html/rfc8414#section-3
 * @returns The handler. It throws when `CLERK_PUBLISHABLE_KEY` is not set.
 * @example
 * ```ts
 * app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
 * ```
 */
export function authorizationServerMetadataHandler() {
  return async (c: Context) => {
    const publishableKey = requirePublishableKey(env<ClerkEnv>(c).CLERK_PUBLISHABLE_KEY);
    const metadata = await fetchAuthorizationServerMetadata({ publishableKey });
    return c.json(metadata);
  };
}

/**
 * Hono middleware that enforces authentication for MCP requests. By default it verifies the OAuth access token with
 * Clerk, including that its audience is this endpoint; pass `verifyToken` to verify tokens with your own function.
 * @param options - `resourceUrl`, the exact URL clients use for this endpoint, the `requiredScopes` every request
 * needs, the `challengeScopes` the 401 challenge also asks for, and either the `clerkClient` that verifies tokens or a
 * `verifyToken` function. Without `clerkClient`, it uses the client that `clerkMiddleware()` sets, so
 * `clerkMiddleware()` must run first. Pass a client created with both `secretKey` and `publishableKey` to keep
 * `clerkMiddleware()` off the MCP route, which otherwise verifies each token a second time. A client from
 * `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check. `verifyToken` is called
 * with the token and the Hono context, and returns the auth data, or `undefined` to reject it.
 * @returns The middleware. A missing or rejected token gets a 401 challenge, a token without `requiredScopes` gets a
 * 403 challenge, and a request to an origin no `resourceUrl` lists gets a 421. The reason is recorded in the
 * `mcpAuthFailure` context variable.
 * @example
 * ```ts
 * app.post(
 *   '/mcp',
 *   mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp', requiredScopes: ['profile', 'email'] }),
 *   streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
 * );
 * ```
 * @example
 * ```ts
 * app.post(
 *   '/mcp',
 *   mcpAuth({ verifyToken: (token, c) => verifyMyToken(token), resourceUrl: 'https://mcp.example.com/mcp' }),
 *   streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
 * );
 * ```
 */
export function mcpAuth(options: McpAuthOptions): MiddlewareHandler {
  assertMiddlewareAuthOptions(options);
  const clerkClientFor = (c: Context) => {
    const client =
      options.clerkClient ?? (c as Context<{ Variables: ClerkHonoVariables }>).get('clerk');
    if (!client) {
      throw new Error(
        'Clerk error: mcpAuth needs a clerkClient option or clerkMiddleware() to run first',
      );
    }
    return client;
  };
  const verifyToken =
    options.verifyToken ?? clerkTokenVerifier(options, clerkClientFor, (c: Context) => c.req.url);

  return async (c: Context, next: Next) => {
    // A missing Clerk client is a mistake in the app's setup, so it is thrown as it is, on a request with or without
    // a token. Thrown by the verifier, it would be the `cause` of an `McpAuthError`, and only once a token arrives.
    if (!options.verifyToken) clerkClientFor(c);

    const result = await authenticateBearer({
      authorization: c.req.header('authorization'),
      requestUrl: c.req.url,
      resourceUrl: options.resourceUrl,
      requiredScopes: options.requiredScopes,
      challengeScopes: options.challengeScopes,
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
 * A Hono handler that serves MCP requests over the streamable HTTP transport, creating a fresh server and transport
 * for each request so that concurrent requests don't share state. It passes on the auth info that `mcpAuth` set.
 * @param createServer - A factory that returns a new MCP server, such as `McpServer` from the MCP SDK, on every
 * call. Passing a server object instead throws when the handler is created.
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
 *   mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp' }),
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
  assertServerFactory(createServer, 'WebStandardStreamableHTTPServerTransport');
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
