import type { McpHttpHandler, McpServer } from '@modelcontextprotocol/server';

import type { AuthInfo } from '../mcp-types';
import { type ClerkEnv, assertMcpAuthOptions, assertVerifierOrResourceUrl } from '../bearer-auth';
import {
  type McpAuthOptions,
  type WorkerExecutionContext,
  withClerkMcpAuth,
} from './with-clerk-mcp-auth';

// MCP SDK 2.x is an optional peer: a Worker that only uses `withClerkMcpAuth` may not have it. So this module imports
// only its types, and loads it with `import()` inside `try` on the first request, as the adapters load Clerk packages.

/**
 * The server factory `createClerkMcpWorker` calls for each MCP request, with the request's verified `authInfo` and the
 * Worker `env` passed to `fetch`. It returns a new MCP SDK 2.x `McpServer` for that request. `authInfo` is
 * `undefined` only for a request without a token that `discoverable` or `publicAccess` let through, such as a
 * `server/discover` probe. Narrow it with `isClerkAuthInfo` before reading Clerk fields such as `extra.userId`.
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

type RequestContext<Env> = { authInfo: AuthInfo | undefined; env: Env };

const caller = 'createClerkMcpWorker from @clerk/mcp-tools/fetch';
const callForm =
  'createClerkMcpWorker({ resourceUrl, server }), or as createClerkMcpWorker({ verifyToken, server }) to verify tokens with your own function';

/**
 * Builds a Worker that serves an authenticated MCP server with MCP SDK 2.x: `createMcpHandler` from
 * `@modelcontextprotocol/server`, behind `withClerkMcpAuth`. It serves every MCP SDK 2.x protocol revision, including
 * 2026-07-28 and its `server/discover`, and the RFC 9728 protected resource metadata the 401 challenge points to.
 *
 * The `server` factory is called for each MCP request with the verified `authInfo` and the Worker `env`, so tools can
 * reach the signed-in user and the Worker's bindings without module-level state. The MCP handler itself is created
 * once, on the first request, so its limits hold across requests.
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
    throw new Error(`Clerk error: ${caller} needs a server factory. Call it as ${callForm}`);
  }
  const { server, ...authOptions } = options;
  assertVerifierOrResourceUrl(
    authOptions,
    `Clerk error: ${caller} needs a resourceUrl to verify tokens with Clerk. Call it as ${callForm}`,
  );
  assertMcpAuthOptions('createClerkMcpWorker', authOptions, new Set(['onAuthFailure']));

  // `createMcpHandler` calls the factory with the request it was given, so each request's auth info and Worker env are
  // found by that request
  const contexts = new WeakMap<Request, RequestContext<Env>>();
  let mcpHandler: Promise<McpHttpHandler> | undefined;
  const loadMcpHandler = () =>
    (mcpHandler ??= createSdkHandler((request) => {
      const context = request && contexts.get(request);
      if (!context) {
        throw new Error(`Clerk error: ${caller} got no Worker env for this MCP request`);
      }
      return server(context);
    }).catch((error: unknown) => {
      // So a later request tries again
      mcpHandler = undefined;
      throw error;
    }));

  const authedHandler = withClerkMcpAuth<Env, Ctx>(
    async (request, { authInfo, env }) => {
      const handler = await loadMcpHandler();
      contexts.set(request, { authInfo, env });
      return handler.fetch(request, { ...(authInfo && { authInfo }) });
    },
    authOptions as McpAuthOptions<Env, Ctx>,
  );

  return { fetch: authedHandler };
}

async function createSdkHandler(
  factory: (request: Request | undefined) => McpServer | Promise<McpServer>,
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
  return sdk.createMcpHandler(({ requestInfo }) => factory(requestInfo));
}
