// Lossless compaction of the tool schemas a `tools/list` result carries, applied to the JSON the MCP SDK already
// produced, so it covers raw Zod shapes, Standard Schema and JSON Schema alike, on MCP SDK 1.x and 2.x, without
// importing the SDK or a schema library.

/**
 * A JSON Schema object, as a `tools/list` result carries it in a tool's `inputSchema` or `outputSchema`.
 */
export type JsonSchemaObject = Record<string, unknown>;

// MCP 2025-11-25 (Basic, JSON Schema Usage): a schema without `$schema` is read as 2020-12
const DEFAULT_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

// The keywords whose value is one subschema, a list of them, or a map of names to them. Only these are walked, so a
// `default`, `const`, `enum` or `examples` value, or a property literally named `additionalProperties`, is never
// rewritten.
const SUBSCHEMA_KEYWORDS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
]);
const SUBSCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems']);
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

const isObject = (value: unknown): value is JsonSchemaObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEmptySchema = (value: unknown) => isObject(value) && Object.keys(value).length === 0;

// An empty `additionalProperties` marks every other property as evaluated, which `unevaluatedProperties` reads, so
// with that keyword anywhere in the schema dropping it could change what the schema accepts
function mentionsUnevaluatedProperties(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(mentionsUnevaluatedProperties);
  if (!isObject(schema)) return false;
  return Object.entries(schema).some(
    ([keyword, value]) =>
      keyword === 'unevaluatedProperties' || mentionsUnevaluatedProperties(value),
  );
}

function compactNode(schema: unknown, dropEmptyAdditional: boolean): unknown {
  if (!isObject(schema)) return schema;
  const compactSub = (value: unknown) => compactNode(value, dropEmptyAdditional);
  return Object.fromEntries(
    Object.entries(schema).flatMap(([keyword, value]): [string, unknown][] => {
      if (dropEmptyAdditional && keyword === 'additionalProperties' && isEmptySchema(value))
        return [];
      if (SUBSCHEMA_KEYWORDS.has(keyword)) return [[keyword, compactSub(value)]];
      if (SUBSCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
        return [[keyword, value.map(compactSub)]];
      }
      if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
        return [
          [
            keyword,
            Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, compactSub(sub)])),
          ],
        ];
      }
      return [[keyword, value]];
    }),
  );
}

/**
 * Removes the keywords of a tool's JSON Schema that restate a default, without changing what the schema accepts: a
 * root `$schema` naming JSON Schema 2020-12, which MCP assumes when `$schema` is absent, and every empty
 * `additionalProperties` subschema, which allows what omitting it allows. Any other `$schema`, such as the draft-07
 * one MCP SDK 1.x writes, and every non-empty `additionalProperties` stay. Empty `additionalProperties` also stay
 * when the schema uses `unevaluatedProperties`, which they affect. Only subschema keywords are walked, so a property
 * named `additionalProperties` and values such as `default` and `const` are kept as they are.
 * @param schema - The schema, which is not modified
 * @returns A compacted copy of the schema
 */
export function compactJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
  if (!isObject(schema)) return schema;
  const { $schema, ...rest } = schema;
  const root = $schema === DEFAULT_DIALECT ? rest : schema;
  return compactNode(root, !mentionsUnevaluatedProperties(root)) as JsonSchemaObject;
}

// A `tools/list` result with each tool's schemas compacted
function compactToolsListResult(result: unknown): unknown {
  if (!isObject(result) || !Array.isArray(result.tools)) return result;
  return {
    ...result,
    tools: result.tools.map((tool: unknown) => {
      if (!isObject(tool)) return tool;
      return {
        ...tool,
        ...(isObject(tool.inputSchema) && { inputSchema: compactJsonSchema(tool.inputSchema) }),
        ...(isObject(tool.outputSchema) && { outputSchema: compactJsonSchema(tool.outputSchema) }),
      };
    }),
  };
}

type RequestId = string | number;

/**
 * Tracks the `tools/list` requests among JSON-RPC messages, and compacts the schemas in the responses to them.
 */
export function toolsListCompactor() {
  const pending = new Set<RequestId>();
  const record = (message: unknown) => {
    for (const item of Array.isArray(message) ? message : [message]) {
      if (isObject(item) && item.method === 'tools/list' && item.id !== undefined) {
        pending.add(item.id as RequestId);
      }
    }
  };
  const compactOne = (item: unknown) => {
    if (!isObject(item) || !('result' in item) || !pending.has(item.id as RequestId)) return item;
    pending.delete(item.id as RequestId);
    return { ...item, result: compactToolsListResult(item.result) };
  };
  const compact = (message: unknown) =>
    Array.isArray(message) ? message.map(compactOne) : compactOne(message);
  return { record, compact, isWaiting: () => pending.size > 0 };
}

// A JSON-RPC message sent as one `data:` line of a server-sent event, as the MCP SDK transports write them
const SSE_DATA = /^data: ?(.*)$/;

/**
 * The response to an MCP request, with the tool schemas compacted when `requestBody` is a `tools/list` request and
 * the response carries its result, as JSON or as server-sent events. Any other response is returned as it is.
 * @param requestBody - The request's parsed JSON body
 * @param response - The MCP handler's response
 */
export async function compactToolsListResponse(
  requestBody: unknown,
  response: Response,
): Promise<Response> {
  const compactor = toolsListCompactor();
  compactor.record(requestBody);
  if (!compactor.isWaiting() || !response.ok || !response.body) return response;
  const mediaType = (response.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  const rewrite =
    mediaType === 'application/json'
      ? (text: string) => JSON.stringify(compactor.compact(JSON.parse(text)))
      : mediaType === 'text/event-stream'
        ? (text: string) =>
            text
              .split('\n')
              .map((line) => {
                const data = SSE_DATA.exec(line)?.[1];
                if (data === undefined) return line;
                try {
                  return `data: ${JSON.stringify(compactor.compact(JSON.parse(data)))}`;
                } catch {
                  return line;
                }
              })
              .join('\n')
        : undefined;
  if (!rewrite) return response;
  const text = await response.text();
  let body: string;
  try {
    body = rewrite(text);
  } catch {
    body = text;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

type ConnectedTransport = {
  send?: (message: unknown, options?: unknown) => Promise<void>;
  onmessage?: ((message: unknown, extra?: unknown) => void) | undefined;
};

/**
 * Compacts the schemas of every `tools/list` response a connected MCP SDK transport sends. Call it after
 * `server.connect(transport)`, which sets the transport's `onmessage`.
 * @param transport - The transport, connected to a server
 */
export function compactTransportToolsList(transport: object) {
  const target = transport as ConnectedTransport;
  const { send, onmessage } = target;
  if (typeof send !== 'function' || typeof onmessage !== 'function') return;
  const compactor = toolsListCompactor();
  target.onmessage = (message, extra) => {
    compactor.record(message);
    onmessage.call(target, message, extra);
  };
  target.send = (message, options) => send.call(target, compactor.compact(message), options);
}

/**
 * Options for `streamableHttpHandler`.
 */
export type StreamableHttpHandlerOptions = {
  /**
   * Whether to compact the tool schemas in `tools/list` results, as `compactJsonSchema` does: a root `$schema`
   * naming JSON Schema 2020-12, which MCP assumes without one, and empty `additionalProperties` are left out, which
   * shortens every tool list without changing what any schema accepts. Defaults to `true`; pass `false` to list the
   * schemas exactly as the MCP SDK writes them.
   */
  compactSchemas?: boolean | undefined;
};

/**
 * Throws a `Clerk error:` message unless `options` is `undefined` or a `StreamableHttpHandlerOptions` object.
 * @param caller - The entry point named in the message, such as `streamableHttpHandler`
 * @param options - The options, unchecked
 */
export function assertCompactSchemasOption(caller: string, options: unknown) {
  if (options === undefined) return;
  if (!isObject(options)) {
    throw new Error(
      `Clerk error: ${caller} takes an options object, such as { compactSchemas: false }`,
    );
  }
  const unknownKey = Object.keys(options).find((key) => key !== 'compactSchemas');
  if (unknownKey !== undefined) {
    throw new Error(`Clerk error: ${caller} has no ${unknownKey} option. It takes compactSchemas`);
  }
  const { compactSchemas } = options;
  if (compactSchemas !== undefined && typeof compactSchemas !== 'boolean') {
    throw new Error(`Clerk error: ${caller} compactSchemas must be true or false`);
  }
}

/**
 * The part of an MCP SDK `McpServer` that `compactToolSchemas` uses: connecting it to a transport.
 */
type ConnectableServer = { connect(transport: never): Promise<void> };

/**
 * Compacts the tool schemas of every `tools/list` result `server` sends, as `compactJsonSchema` does, on every
 * transport it connects to after this call. The adapters' MCP handlers, `streamableHttpHandler` and
 * `withClerkMcpAuth`, already do this by default; use it for a server you serve another way, before calling
 * `server.connect`. It works on MCP SDK 1.x and 2.x `McpServer`s, whatever their tools' schemas are written in,
 * since it compacts the JSON Schema the SDK lists. Clients validate tool inputs and outputs the same either way.
 * @param server - The MCP server, such as `McpServer` from the MCP SDK
 * @returns The same server
 * @example
 * ```ts
 * const server = compactToolSchemas(new McpServer({ name: 'docs', version: '1.0.0' }));
 * server.registerTool(...);
 * await server.connect(transport);
 * ```
 */
export function compactToolSchemas<Server extends ConnectableServer>(server: Server): Server {
  if (!isObject(server) || typeof server.connect !== 'function') {
    throw new Error(
      'Clerk error: compactToolSchemas takes an MCP server with connect(), such as new McpServer(...) from the MCP SDK',
    );
  }
  const connect = server.connect.bind(server) as (transport: object) => Promise<void>;
  (server as unknown as { connect: (transport: object) => Promise<void> }).connect = async (
    transport,
  ) => {
    await connect(transport);
    compactTransportToolsList(transport);
  };
  return server;
}
