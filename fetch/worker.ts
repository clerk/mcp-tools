import type { McpHttpHandler, McpServer } from '@modelcontextprotocol/server';

import type { AuthInfo } from '../mcp-types';
import type { ClerkEnv } from '../bearer-auth';
import {
  type McpAuthOptions,
  type WorkerExecutionContext,
  fetchMcpAuth,
} from './with-clerk-mcp-auth';

// MCP SDK 2.x is an optional peer: a Worker that only uses `withClerkMcpAuth` may not have it. So this module imports
// only its types, and loads it with `import()` inside `try` on the first request, as the adapters load Clerk packages.

/**
 * The server factory `createClerkMcpWorker` calls for each MCP request, with the request's verified `authInfo` and the
 * Worker `env` passed to `fetch`. It returns a new MCP SDK 2.x `McpServer` for that request. `authInfo` is
 * `undefined` only for a request without a token that `discoverable` or `publicAccess` let through, such as a
 * `server/discover` probe. Narrow it with `isClerkAuthInfo` before reading Clerk fields such as `extra.userId`. It gets
 * no `ctx`: the MCP handler that calls it is shared by every request with the same `env`, and the SDK passes the
 * factory only the auth info, so a Worker whose tools need `ctx.waitUntil` wraps its own handler with
 * `withClerkMcpAuth`.
 */
export type ClerkMcpServerFactory<Env = ClerkEnv> = (context: {
  authInfo: AuthInfo | undefined;
  env: Env;
}) => McpServer | Promise<McpServer>;

/**
 * Options for `createClerkMcpWorker`: the `server` factory, and the same auth options as `withClerkMcpAuth`.
 */
export type ClerkMcpWorkerOptions<Env = ClerkEnv, Ctx = WorkerExecutionContext> = McpAuthOptions<
  Env,
  Ctx
> & {
  server: ClerkMcpServerFactory<Env>;
};

/** The Worker export `createClerkMcpWorker` returns: `export default` it. */
export type ClerkMcpWorker<Env = ClerkEnv, Ctx = WorkerExecutionContext> = {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response>;
};

const createClerkMcpWorkerCaller = 'createClerkMcpWorker from @clerk/mcp-tools/fetch';
const createClerkMcpWorkerCallForm =
  'createClerkMcpWorker({ resourceUrl, server }), or as createClerkMcpWorker({ verifyToken, server }) to verify tokens with your own function';

/**
 * Builds a Worker that serves an authenticated MCP server with MCP SDK 2.x: `createMcpHandler` from
 * `@modelcontextprotocol/server`, behind `withClerkMcpAuth`. It serves every MCP SDK 2.x protocol revision, including
 * 2026-07-28 and its `server/discover`, and the RFC 9728 protected resource metadata the 401 challenge points to.
 *
 * The `server` factory is called for each MCP request with the verified `authInfo` and the Worker `env`, so tools can
 * reach the signed-in user and the Worker's bindings without module-level state. The MCP handler itself is created
 * once for each Worker `env`, on its first request, so its limits hold across requests: Cloudflare passes the same
 * `env` to every request of an isolate. That sharing is why the factory gets no `ctx`: the SDK passes it only the
 * request's auth info, and a side channel keyed on the request would break when the SDK clones it.
 *
 * The Worker owns every path it is routed: the metadata URL of each listed `resourceUrl` gets the metadata, and every
 * other path is the MCP endpoint. A Worker with other routes sends only those two URLs to it, or uses
 * `withClerkMcpAuth`.
 * @param options - The `server` factory, and the auth options of `withClerkMcpAuth`: `resourceUrl` (or
 * `verifyToken`), `requiredScopes`, `challengeScopes`, `discoverable`, `publicAccess`, `clerkClient`, and
 * `onAuthFailure`
 * @returns A Worker export, `{ fetch(request, env, ctx) }`. It answers as `withClerkMcpAuth` does, and serves MCP for
 * each request that passed the auth check. A request throws a `Clerk error:` asking to install
 * `@modelcontextprotocol/server` when it can't be loaded.
 * @example
 * ```ts
 * import { McpServer } from '@modelcontextprotocol/server';
 * import { type ClerkEnv, createClerkMcpWorker, isClerkAuthInfo } from '@clerk/mcp-tools/fetch';
 *
 * export default createClerkMcpWorker<ClerkEnv>({
 *   resourceUrl: 'https://mcp.example.com/mcp',
 *   server: ({ authInfo, env }) => {
 *     const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 *     // Register tools that read `authInfo` and `env`
 *     return server;
 *   },
 * });
 * ```
 */
export function createClerkMcpWorker<Env = ClerkEnv, Ctx = WorkerExecutionContext>(
  options: ClerkMcpWorkerOptions<Env, Ctx>,
): ClerkMcpWorker<Env, Ctx> {
  if (typeof options?.server !== 'function') {
    throw new Error(
      `Clerk error: ${createClerkMcpWorkerCaller} needs a server factory. Call it as ${createClerkMcpWorkerCallForm}`,
    );
  }
  const { server, ...authOptions } = options;

  // One MCP handler for each Worker env, whose factory is closed over that env, so the env never travels through the
  // SDK. The auth info does: `createMcpHandler` documents `authInfo` as passed through from `handler.fetch` to the
  // factory's context, and the tests check that it arrives. An env that is not an object, which Cloudflare never
  // passes, gets a handler for its request alone.
  const handlers = new WeakMap<object, Promise<McpHttpHandler>>();
  const loadMcpHandler = (env: Env) => {
    const key = typeof env === 'object' && env !== null ? env : undefined;
    const cached = key && handlers.get(key);
    if (cached) return cached;
    const created = createSdkHandler(({ authInfo }) =>
      server({ authInfo: authInfo as AuthInfo | undefined, env }),
    ).catch((error: unknown) => {
      // So a later request tries again
      if (key) handlers.delete(key);
      throw error;
    });
    if (key) handlers.set(key, created);
    return created;
  };

  const authedHandler = fetchMcpAuth<Env, Ctx>(
    async (request, { authInfo, env }) => {
      const handler = await loadMcpHandler(env);
      return handler.fetch(request, { ...(authInfo && { authInfo }) });
    },
    authOptions as McpAuthOptions<Env, Ctx>,
    createClerkMcpWorkerCaller,
    createClerkMcpWorkerCallForm,
  );

  return { fetch: authedHandler };
}

async function createSdkHandler(
  factory: (context: { authInfo?: unknown }) => McpServer | Promise<McpServer>,
): Promise<McpHttpHandler> {
  let sdk: typeof import('@modelcontextprotocol/server');
  try {
    sdk = await import('@modelcontextprotocol/server');
  } catch (error) {
    throw new Error(
      'Clerk error: install @modelcontextprotocol/server to serve MCP with createClerkMcpWorker, or wrap your own MCP handler with withClerkMcpAuth',
      { cause: error },
    );
  }
  return sdk.createMcpHandler(factory);
}
