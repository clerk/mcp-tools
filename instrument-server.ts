// Observes the tool calls and other requests of an MCP server. Exported from the core subpath and every adapter.
import {
  PROTOCOL_VERSION_META_KEY,
  type RequestEventFields,
  type ToolCallOutcome,
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
 * Lets Clerk see the tool calls and other requests of an MCP server that `clerkInstrumentHandler` serves, to report
 * them when its `reporting` option is on. Call it once on each server where it is created, before the server
 * connects: in the factory you give the MCP SDK's `createMcpHandler`, or in the callback of `createMcpHandler` from
 * `mcp-handler`. It changes nothing a client sees, and a second call on the same server does nothing.
 *
 * It replaces `connect` on this server object only, then wraps the `onmessage` and `send` of each transport the server
 * connects to, so it works the same with every MCP SDK version and with servers that `mcp-handler` creates. Besides
 * tool calls, it reports each `initialize` (and, on protocol revision 2026-07-28, `server/discover`) with the client's
 * name and version, each list request with its item count, and each resource read and prompt get. A tool call that a
 * request without `clerkInstrumentHandler` sends with auth info, such as through `mcpAuth`, logs a one-time
 * `Clerk warning:`.
 *
 * It also wraps `registerTool`, `registerResource` and `registerPrompt`, and `tool`, `resource` and `prompt` on MCP
 * SDK 1.x, on this server object, so each handler registered after it reports how long it ran, and reports a handler
 * that threw as an error with the code `thrown:<ErrorClass>`, the error's class name and never its message. A resource
 * read is reported by the name and URI template of the resource registered after it that it matched, and otherwise by
 * the URI's scheme alone: the URI a client asked for is never sent. Anything registered before the call, or whose
 * callback is replaced with `update({ callback })`, is still reported, without the handler's time, and a throw looks
 * like a returned `isError` result or a JSON-RPC error.
 * @param server - An MCP SDK `McpServer` or low-level `Server`
 * @returns The same server
 * @example
 * ```ts
 * const mcp = createMcpHandler(() => {
 *   const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
 *   clerkInstrumentServer(server);
 *   // register tools, resources and prompts
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
      observeTransport(transport, server);
      return result;
    };
  timeHandlers(server);
  return server;
}

type Callback = (this: unknown, ...args: unknown[]) => unknown;

// The last argument of a handler: `extra` on MCP SDK 1.x, `ctx` on 2.x
type HandlerExtra = {
  requestId?: unknown;
  authInfo?: unknown;
  mcpReq?: { id?: unknown };
  http?: { authInfo?: unknown };
};

// What was registered through the wrapped methods, to name a resource read by the resource it matched, and to tell a
// read or prompt of nothing registered from another error
type Registered = {
  resources: Map<string, string>;
  templates: { name: string; template: string; match(uri: string): unknown }[];
  prompts: Set<string>;
};

const registries = new WeakMap<object, Registered>();
// The protocol version each server answered `initialize` with, for the requests that follow on the same server
const negotiatedVersions = new WeakMap<object, string>();

type UriTemplateLike = { match(uri: string): unknown; toString(): string };

const uriTemplateOf = (value: unknown): UriTemplateLike | undefined => {
  const template = (value as { uriTemplate?: unknown } | null)?.uriTemplate;
  return typeof (template as UriTemplateLike | undefined)?.match === 'function'
    ? (template as UriTemplateLike)
    : undefined;
};

// Wraps the registration methods of this server object, on MCP SDK 1.x and 2.x, so each handler registered from now
// on records its time and whether it threw into the request's context. It only records: the report is sent when the
// response passes through the transport, and anything registered earlier is reported from that alone.
function timeHandlers(server: object) {
  const target = server as Record<string, unknown>;
  const registered: Registered = { resources: new Map(), templates: [], prompts: new Set() };
  registries.set(server, registered);
  const note: Record<string, (args: unknown[]) => void> = {
    registerResource: (args) => noteResource(registered, args),
    resource: (args) => noteResource(registered, args),
    registerPrompt: ([name]) => typeof name === 'string' && registered.prompts.add(name),
    prompt: ([name]) => typeof name === 'string' && registered.prompts.add(name),
  };
  for (const method of ['registerTool', 'tool', ...Object.keys(note)]) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      try {
        note[method]?.(args);
      } catch {}
      // `registerTool` takes the callback third; every other method takes it last
      const index = method === 'registerTool' ? 2 : args.length - 1;
      args[index] = timedHandler(args[index]);
      return (original as Callback).apply(this, args);
    };
  }
}

// `registerResource(name, uriOrTemplate, config, callback)` and `resource(name, uriOrTemplate, [metadata], callback)`
function noteResource(registered: Registered, [name, uriOrTemplate]: unknown[]) {
  if (typeof name !== 'string') return;
  if (typeof uriOrTemplate === 'string') {
    registered.resources.set(uriOrTemplate, name);
    return;
  }
  const uriTemplate = uriTemplateOf(uriOrTemplate);
  if (!uriTemplate) return;
  registered.templates.push({
    name,
    template: String(uriTemplate.toString()),
    match: (uri) => uriTemplate.match(uri),
  });
}

function timedHandler(callback: unknown): unknown {
  if (typeof callback !== 'function') return callback;
  return function (this: unknown, ...args: unknown[]) {
    let finish: ((thrown: { error: unknown } | undefined) => void) | undefined;
    try {
      const extra = args[args.length - 1] as HandlerExtra | null | undefined;
      const key = requestKey(extra?.requestId ?? extra?.mcpReq?.id);
      const context = toolCallContextOf(extra?.authInfo ?? extra?.http?.authInfo);
      if (context && key !== undefined) finish = context.startHandler(key);
    } catch {}
    if (!finish) return (callback as Callback).apply(this, args);
    const done = (thrown: { error: unknown } | undefined) => {
      try {
        finish(thrown);
      } catch {}
    };
    let result: unknown;
    try {
      result = (callback as Callback).apply(this, args);
    } catch (error) {
      done({ error });
      throw error;
    }
    if (typeof (result as PromiseLike<unknown> | null)?.then !== 'function') {
      done(undefined);
      return result;
    }
    return (result as PromiseLike<unknown>).then(
      (value) => {
        done(undefined);
        return value;
      },
      (error: unknown) => {
        done({ error });
        throw error;
      },
    );
  };
}

/**
 * Names a resource read by what it matched among the resources registered through `clerkInstrumentServer`: a fixed
 * resource by its name, and a template by its name and URI template. Otherwise only the URI's scheme is named. The URI
 * itself is never returned, since it can carry user data.
 */
function describeResource(
  server: object,
  uri: unknown,
): {
  fields: Pick<
    Extract<RequestEventFields, { type: 'resource_read' }>,
    'resource_name' | 'resource_uri_template' | 'resource_uri_scheme'
  >;
  registered: boolean | undefined;
} {
  if (typeof uri !== 'string') return { fields: {}, registered: undefined };
  const registered = registries.get(server);
  const known =
    registered && (registered.resources.size > 0 || registered.templates.length > 0)
      ? registered
      : undefined;
  // The MCP SDK looks a resource up by the URI as `URL` serializes it
  let normalized: string | undefined;
  try {
    normalized = new URL(uri).toString();
  } catch {}
  if (known && normalized !== undefined) {
    const name = known.resources.get(normalized) ?? known.resources.get(uri);
    if (name !== undefined) return { fields: { resource_name: name }, registered: true };
    const template = known.templates.find((candidate) => {
      try {
        return Boolean(candidate.match(normalized));
      } catch {
        return false;
      }
    });
    if (template) {
      return {
        fields: { resource_name: template.name, resource_uri_template: template.template },
        registered: true,
      };
    }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase();
  return {
    fields: scheme === undefined ? {} : { resource_uri_scheme: scheme },
    registered: known ? false : undefined,
  };
}

// The outcome of a resource read or prompt get. A read of nothing registered, or a prompt that isn't, is `not_found`:
// the spec's -32002, or the -32602 the MCP SDK answers it with. Neither the message nor the data is read, since both
// carry the URI.
function handledOutcome(
  response: JsonRpcMessage,
  registered: boolean | undefined,
): ToolCallOutcome {
  if (response.error === undefined) return { status: 'success' };
  const code = (response.error as { code?: unknown } | null)?.code;
  if (code === -32002 || (code === -32602 && registered === false)) {
    return { status: 'error', errorCode: 'not_found' };
  }
  return toolCallOutcome(response);
}

// The array each list method's result holds its items in
const LIST_ITEMS: Record<string, string> = {
  'tools/list': 'tools',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
  'prompts/list': 'prompts',
  'tasks/list': 'tasks',
};

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

type Params = Record<string, unknown> | null | undefined;

const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);

function clientFields(clientInfo: unknown, requested: unknown) {
  const { name, version } = (clientInfo ?? {}) as { name?: unknown; version?: unknown };
  return {
    type: 'client_initialized' as const,
    client_name: asString(name),
    client_version: asString(version),
    requested_protocol_version: asString(requested),
  };
}

// What to report for a request once its response is sent, for each method reported other than `tools/call`. It
// returns `undefined` when the response reports nothing, such as a failed `initialize`.
type Observed = (
  response: JsonRpcMessage,
) => { fields: RequestEventFields; outcome?: ToolCallOutcome } | undefined;

// The protocol version of a request: the one its `_meta` names on protocol revision 2026-07-28, or else the one its
// server negotiated in `initialize`, which a server created for each request never sees
function protocolVersionOf(server: object, params: Params): string | undefined {
  const meta = params?._meta as Params;
  return asString(meta?.[PROTOCOL_VERSION_META_KEY]) ?? negotiatedVersions.get(server);
}

function observeRequest(server: object, method: string, params: Params): Observed | undefined {
  const observed = observeMethod(server, method, params);
  if (!observed || method === 'initialize' || method === 'server/discover') return observed;
  const protocolVersion = protocolVersionOf(server, params);
  if (protocolVersion === undefined) return observed;
  return (response) => {
    const report = observed(response);
    return report && { ...report, fields: { ...report.fields, protocol_version: protocolVersion } };
  };
}

function observeMethod(server: object, method: string, params: Params): Observed | undefined {
  if (method === 'initialize') {
    return (response) => {
      if (response.error !== undefined) return undefined;
      const result = response.result as { protocolVersion?: unknown } | null | undefined;
      const negotiated = asString(result?.protocolVersion);
      if (negotiated !== undefined) negotiatedVersions.set(server, negotiated);
      return {
        fields: {
          ...clientFields(params?.clientInfo, params?.protocolVersion),
          protocol_version: asString(result?.protocolVersion),
        },
      };
    };
  }
  // Protocol revision 2026-07-28 has no `initialize`: each request names its client and version in `_meta`, and
  // `server/discover` is the request a client makes before any other, when it makes one
  if (method === 'server/discover') {
    return (response) => {
      if (response.error !== undefined) return undefined;
      const meta = params?._meta as Params;
      const requested = meta?.[PROTOCOL_VERSION_META_KEY];
      return {
        fields: {
          ...clientFields(meta?.[CLIENT_INFO_META_KEY], requested),
          protocol_version: asString(requested),
        },
      };
    };
  }
  const itemsKey = LIST_ITEMS[method];
  if (itemsKey !== undefined) {
    return (response) => {
      if (response.error !== undefined) return undefined;
      const items = (response.result as Params)?.[itemsKey];
      return {
        fields: {
          type: 'list_request',
          method,
          ...(Array.isArray(items) && { item_count: items.length }),
        },
      };
    };
  }
  if (method === 'resources/read') {
    const { fields, registered } = describeResource(server, params?.uri);
    return (response) => ({
      fields: { type: 'resource_read', ...fields },
      outcome: handledOutcome(response, registered),
    });
  }
  if (method === 'prompts/get') {
    const name = asString(params?.name);
    if (name === undefined) return undefined;
    const prompts = registries.get(server)?.prompts;
    const registered = prompts && prompts.size > 0 ? prompts.has(name) : undefined;
    return (response) => {
      const messages = (response.result as Params)?.messages;
      return {
        fields: {
          type: 'prompt_get',
          prompt_name: name,
          ...(Array.isArray(messages) && { message_count: messages.length }),
        },
        outcome: handledOutcome(response, registered),
      };
    };
  }
  return undefined;
}

// The name the server was created with. The MCP SDK keeps it on `_serverInfo` in 1.x and 2.x, which has no public
// accessor, so a server without it is reported without a name.
function serverNameOf(server: object): string | undefined {
  const lowLevel = (server as { server?: unknown }).server ?? server;
  const name = (lowLevel as { _serverInfo?: { name?: unknown } } | null)?._serverInfo?.name;
  return typeof name === 'string' ? name : undefined;
}

// Whether the server has no tool named `name`. The MCP SDK's `McpServer` keeps every tool it serves, however it was
// registered, in `_registeredTools` in 1.x and 2.x, which has no public accessor, and answers `tools/call` from it once
// `_toolHandlersInitialized` is set. Without both, such as on a low-level `Server` or an `McpServer` whose `tools/call`
// handler is the app's own, it gives no answer, and neither does the set of tools `clerkInstrumentServer` wrapped,
// which misses those registered before it.
function isUnknownTool(server: object, name: string): boolean {
  try {
    const { _registeredTools: tools, _toolHandlersInitialized: answersCalls } = server as {
      _registeredTools?: unknown;
      _toolHandlersInitialized?: unknown;
    };
    return (
      answersCalls === true &&
      typeof tools === 'object' &&
      tools !== null &&
      !Object.hasOwn(tools, name)
    );
  } catch {
    return false;
  }
}

function requestKey(id: unknown): string | undefined {
  if (typeof id === 'number') return `n:${id}`;
  if (typeof id === 'string') return `s:${id}`;
  return undefined;
}

// The server sets `onmessage` while connecting, so it is wrapped after `connect` resolves, before the transport
// delivers any message. Observation never throws into the transport.
function observeTransport(transport: unknown, server: object) {
  const target = transport as Partial<ObservableTransport> | null;
  if (!target || observedTransports.has(target)) return;
  const { onmessage, send } = target;
  if (typeof onmessage !== 'function' || typeof send !== 'function') return;
  observedTransports.add(target);

  const pending = new Map<string, (response: JsonRpcMessage) => void>();

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
          const finish = context.startToolCall(
            toolName,
            serverNameOf(server),
            key,
            protocolVersionOf(server, params as Params),
          );
          const unknown = isUnknownTool(server, toolName);
          if (finish) {
            pending.set(key, (response) => {
              const outcome = toolCallOutcome(response);
              finish(
                unknown && outcome.status === 'error'
                  ? { status: 'error', errorCode: 'not_found' }
                  : outcome,
              );
            });
          }
        }
      } else if (context && typeof method === 'string' && key !== undefined) {
        const observed = observeRequest(server, method, params as Params);
        const finish = observed && context.startRequest(serverNameOf(server), key);
        if (observed && finish) {
          pending.set(key, (response) => {
            const report = observed(response);
            if (report) finish(report.fields, report.outcome);
          });
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
          finish(response);
        }
      }
    } catch {}
    return send.call(this, message, ...rest);
  };
}
