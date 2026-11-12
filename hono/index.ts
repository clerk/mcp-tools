import type { AuthInfo, McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { env } from 'hono/adapter';
import {
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMiddlewareAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertServerFactory,
  assertTransportClass,
  authenticateBearer,
  clerkProtectedResourceMetadata,
  clerkTokenVerifier,
  failureHeaders,
  readJsonBody,
  requirePublishableKey,
} from '../bearer-auth';
import {
  type ClerkOAuthClient,
  type McpAuthFailure,
  fetchAuthorizationServerMetadata,
} from '../server';

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * The auth info of the request's verified token, or `undefined` for a request without a token that
     * `publicAccess` let through.
     */
    mcpAuth: AuthInfo | undefined;
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
 * its audience, and `clerkClient` defaults to one built from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the
 * app's environment. With `verifyToken`, that
 * function verifies each token with the Hono context, `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type McpAuthOptions = MiddlewareAuthOptions<Context>;

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions`, all optional, plus `properties`, so one object
 * can be passed to both. The handler reads `resourceUrl`, `requiredScopes`, `challengeScopes`, and `properties`, and
 * ignores the other `McpAuthOptions` keys: `clerkClient` and `verifyToken`.
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
  CLERK_SECRET_KEY?: string;
};

// The clients `mcpAuth` built from the environment, by key pair. On Cloudflare Workers the keys are only known per
// request, on `c.env`, so the client can't be built at setup. The cache key is the secret and publishable key
// together, so the secret is part of it; the map lives in memory only and is never logged or persisted. Two
// concurrent first requests for one key pair can each build a client, and the later one replaces the earlier in the
// map; both work, so the duplicate is harmless.
const envClerkClients = new Map<string, ClerkOAuthClient>();

/**
 * The keys a Clerk client is built from, read from the app's environment through `env(c)`.
 * @param c - The Hono context of the request
 * @returns The secret and publishable keys. It throws a `Clerk error:` naming the first one not set.
 */
function requireClerkKeys(c: Context) {
  const { CLERK_SECRET_KEY: secretKey, CLERK_PUBLISHABLE_KEY: publishableKey } = env<ClerkEnv>(c);
  const missingKeyError = (name: string) =>
    new Error(
      `Clerk error: mcpAuth needs the ${name} environment variable or a clerkClient option`,
    );
  if (!secretKey) throw missingKeyError('CLERK_SECRET_KEY');
  if (!publishableKey) throw missingKeyError('CLERK_PUBLISHABLE_KEY');
  return { secretKey, publishableKey };
}

/**
 * The Clerk client built from the environment's keys, loading `@clerk/backend` the first time. The package is an
 * optional peer that only this path needs, so it is loaded with `import()` inside `try`: a bundler such as esbuild
 * fails the build on a bare `import()` of a missing package, but not on one inside `try`.
 * @param keys - The secret and publishable keys
 * @returns The client, the same one for the same keys
 */
async function envClerkClient(keys: { secretKey: string; publishableKey: string }) {
  const cacheKey = `${keys.secretKey}\n${keys.publishableKey}`;
  const cached = envClerkClients.get(cacheKey);
  if (cached) return cached;

  let backend: typeof import('@clerk/backend');
  try {
    backend = await import('@clerk/backend');
  } catch (error) {
    throw new Error('Clerk error: install @clerk/backend, or pass clerkClient to mcpAuth', {
      cause: error,
    });
  }

  const client = backend.createClerkClient(keys);
  envClerkClients.set(cacheKey, client);
  return client;
}

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
 * @returns The handler. It throws when `CLERK_PUBLISHABLE_KEY` is not set. Passing
 * `authorizationServerMetadataHandler` to the route without calling it throws a `Clerk error:` on the first request.
 * @example
 * ```ts
 * app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
 * ```
 */
export function authorizationServerMetadataHandler() {
  // `arguments`, not a rest parameter, so the declared signature still takes no arguments
  assertAuthorizationServerMetadataHandlerCalled(arguments.length);
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
 * `verifyToken` function. Without `clerkClient`, it builds one with `createClerkClient` from `@clerk/backend`, from
 * `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` read through `env(c)`, kept for each key pair. Keep
 * `clerkMiddleware()` off the MCP route, which otherwise verifies each token a second time. A client from `@clerk/backend` must be version 3.19.0 or later,
 * the first with a reliable audience check. `verifyToken` is called
 * with the token and the Hono context, and returns the auth data, or `undefined` to reject it.
 * @returns The middleware. A missing or rejected token gets a 401 challenge, a token without `requiredScopes` gets a
 * 403 challenge, and a request to an origin no `resourceUrl` lists gets a 421. The reason is recorded in the
 * `mcpAuthFailure` context variable. Without a Clerk client, it throws a `Clerk error:` naming a missing key, or
 * asking to install `@clerk/backend` when it can't be loaded.
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
  const clerkClientFor = async (c: Context): Promise<ClerkOAuthClient> =>
    options.clerkClient ?? envClerkClient(requireClerkKeys(c));
  const verifyToken =
    options.verifyToken ?? clerkTokenVerifier(options, clerkClientFor, (c: Context) => c.req.url);

  return async (c: Context, next: Next) => {
    // A missing Clerk client is a mistake in the app's setup, so it is thrown as it is, on a request with or without
    // a token. Thrown by the verifier, it would be the `cause` of an `McpAuthError`, and only once a token arrives.
    if (!options.verifyToken) await clerkClientFor(c);

    const result = await authenticateBearer({
      authorization: c.req.header('authorization'),
      requestUrl: c.req.url,
      resourceUrl: options.resourceUrl,
      requiredScopes: options.requiredScopes,
      challengeScopes: options.challengeScopes,
      publicAccess: options.publicAccess,
      method: c.req.method,
      // A clone, so the MCP transport can still read the request
      body: () => readJsonBody(c.req.raw),
      verifyToken: (token) => verifyToken(token, c),
    });

    if (!result.ok) {
      if (result.failure) c.set('mcpAuthFailure', result.failure);
      return c.json(
        { error: result.error },
        { status: result.status, headers: failureHeaders(result) },
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
