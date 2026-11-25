// Observes the tool calls of an MCP server. Exported from the core subpath and every adapter.
import {
  toolCallContextOf,
  toolCallOutcome,
  warnOutsideInstrumentHandler,
} from './tool-call-reporting';

/**
 * An MCP server `clerkInstrumentServer` can instrument: anything with the `connect` method of the MCP SDK's `McpServer`
 * and low-level `Server`, on SDK 1.x and 2.x.
 */
export type InstrumentableMcpServer = {
  connect(...args: never[]): Promise<unknown>;
};

type JsonRpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type ObservableTransport = {
  onmessage?: (this: unknown, message: unknown, extra?: { authInfo?: unknown }) => unknown;
  send: (this: unknown, message: unknown, ...rest: unknown[]) => Promise<unknown>;
};

const instrumentedServers = new WeakSet<object>();
const observedTransports = new WeakSet<object>();

/**
 * Lets Clerk see the tool calls of an MCP server that `clerkInstrumentHandler` serves, to report them when its
 * `reporting` option is on. Call it once on each server where it is created, before the server connects: in the
 * factory you give the MCP SDK's `createMcpHandler`, or in the callback of `createMcpHandler` from `mcp-handler`.
 * It changes nothing a client sees, and a second call on the same server does nothing.
 *
 * It replaces `connect` on this server object only, then wraps the `onmessage` and `send` of each transport the server
 * connects to, so it works the same with every MCP SDK version and with servers that `mcp-handler` creates. A tool
 * call that a request without `clerkInstrumentHandler` sends with auth info, such as through `mcpAuth`, logs a
 * one-time `Clerk warning:`.
 * @param server - An MCP SDK `McpServer` or low-level `Server`
 * @returns The same server
 * @example
 * ```ts
 * const mcp = createMcpHandler(() => {
 *   const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
 *   clerkInstrumentServer(server);
 *   // register tools
 *   return server;
 * });
 * ```
 */
export function clerkInstrumentServer<Server extends InstrumentableMcpServer>(
  server: Server,
): Server {
  const connect = (server as { connect?: unknown } | null)?.connect;
  if (typeof connect !== 'function') {
    throw new Error(
      'Clerk error: clerkInstrumentServer takes an MCP server, such as new McpServer(...) or the server mcp-handler passes to its callback',
    );
  }
  if (instrumentedServers.has(server)) return server;
  instrumentedServers.add(server);

  (server as unknown as { connect: (...args: unknown[]) => Promise<unknown> }).connect =
    async function (this: unknown, transport: unknown, ...rest: unknown[]) {
      const result = await connect.call(this, transport, ...rest);
      observeTransport(transport, () => serverNameOf(server));
      return result;
    };
  return server;
}

// The name the server was created with. The MCP SDK keeps it on `_serverInfo` in 1.x and 2.x, which has no public
// accessor, so a server without it is reported without a name.
function serverNameOf(server: object): string | undefined {
  const lowLevel = (server as { server?: unknown }).server ?? server;
  const name = (lowLevel as { _serverInfo?: { name?: unknown } } | null)?._serverInfo?.name;
  return typeof name === 'string' ? name : undefined;
}

function requestKey(id: unknown): string | undefined {
  if (typeof id === 'number') return `n:${id}`;
  if (typeof id === 'string') return `s:${id}`;
  return undefined;
}

// The server sets `onmessage` while connecting, so it is wrapped after `connect` resolves, before the transport
// delivers any message. Observation never throws into the transport.
function observeTransport(transport: unknown, serverName: () => string | undefined) {
  const target = transport as Partial<ObservableTransport> | null;
  if (!target || observedTransports.has(target)) return;
  const { onmessage, send } = target;
  if (typeof onmessage !== 'function' || typeof send !== 'function') return;
  observedTransports.add(target);

  const pending = new Map<string, (outcome: ReturnType<typeof toolCallOutcome>) => void>();

  target.onmessage = function (message, extra) {
    try {
      const context = toolCallContextOf(extra?.authInfo);
      if (context) context.connected = true;
      const { id, method, params } = (message ?? {}) as JsonRpcMessage;
      const key = requestKey(id);
      if (method === 'tools/call' && key !== undefined) {
        const toolName = (params as { name?: unknown } | null)?.name;
        if (!context) {
          if (extra?.authInfo !== undefined) warnOutsideInstrumentHandler();
        } else if (typeof toolName === 'string') {
          const finish = context.startToolCall(toolName, serverName());
          if (finish) pending.set(key, finish);
        }
      }
    } catch {}
    return onmessage.call(this, message, extra);
  };

  target.send = function (message, ...rest) {
    try {
      if (pending.size > 0) {
        const response = (message ?? {}) as JsonRpcMessage;
        const key = response.method === undefined ? requestKey(response.id) : undefined;
        const finish = key === undefined ? undefined : pending.get(key);
        if (finish && key !== undefined) {
          pending.delete(key);
          finish(toolCallOutcome(response));
        }
      }
    } catch {}
    return send.call(this, message, ...rest);
  };
}
