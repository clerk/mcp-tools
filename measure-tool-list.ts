// Measures what a `tools/list` result costs a client: its size in characters and an approximate token count.
import { compactTransportToolsList, readCompactSchemas } from './compact-schemas';
import { failFor, isPlainObject } from './discovery-options';

/**
 * The size of one tool in a `tools/list` result, in characters of JSON, as `measureToolList` reports it.
 */
export type ToolMeasurement = {
  /**
   * The tool's name.
   */
  name: string;
  /**
   * The whole tool definition, serialized.
   */
  characters: number;
  /**
   * The description's length, or 0 without one.
   */
  description: number;
  /**
   * The serialized `inputSchema`.
   */
  inputSchema: number;
  /**
   * The serialized `outputSchema`, or 0 without one.
   */
  outputSchema: number;
  /**
   * The serialized `_meta`, or 0 without one.
   */
  meta: number;
};

/**
 * The size of a `tools/list` result, as `measureToolList` reports it.
 */
export type ToolListMeasurement = {
  /**
   * Each tool, in list order.
   */
  tools: ToolMeasurement[];
  /**
   * The sums of the tools' description, schema and `_meta` counts, and in `characters` the length of the whole
   * serialized result.
   */
  totals: Omit<ToolMeasurement, 'name'>;
  /**
   * `totals.characters` divided by 4, rounded up: the common rule of thumb of about 4 characters of English or JSON
   * per token. Tokenizers differ, so use it to compare lists and set a budget, not to predict a model's exact count.
   */
  approximateTokens: number;
};

/**
 * The result of a `tools/list` request, such as an MCP client's `listTools()` returns.
 */
export type ToolsListResult = { tools: readonly Record<string, unknown>[] };

/**
 * Options for `measureToolList`.
 */
export type MeasureToolListOptions = {
  /**
   * For a server, whether to measure its tool list with the schemas compacted, as the adapters'
   * `streamableHttpHandler` and `withClerkMcpAuth` serve it by default. Defaults to `true`; pass `false` to measure
   * the list as the MCP SDK writes it. A `tools/list` result is always measured as it is given.
   */
  compactSchemas?: boolean | undefined;
};

type MeasurableServer = { connect(transport: never): Promise<void>; close?: () => Promise<void> };

type JsonRpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

const CALLER = 'measureToolList';

// The protocol revision the in-memory client initializes with. Every revision an MCP SDK 1.x or 2.x server
// negotiates lists the same tools, so the measurement doesn't depend on it.
const MEASURING_PROTOCOL_VERSION = '2025-11-25';

const serializedLength = (value: unknown) =>
  value === undefined ? 0 : JSON.stringify(value).length;

// Every page of the server's tool list, read over an in-memory transport as a client would
async function listTools(
  server: MeasurableServer,
  compactSchemas: boolean,
): Promise<ToolsListResult> {
  const waiting = new Map<number, (message: JsonRpcMessage) => void>();
  const transport = {
    onmessage: undefined as ((message: unknown, extra?: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    start: async () => {},
    send: async (message: unknown) => {
      const reply = message as JsonRpcMessage;
      if (typeof reply.id === 'number') waiting.get(reply.id)?.(reply);
    },
    close: async () => transport.onclose?.(),
  };
  await (server.connect as (transport: object) => Promise<void>)(transport);
  if (compactSchemas) compactTransportToolsList(transport);

  let nextId = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    const reply = await new Promise<JsonRpcMessage>((resolve) => {
      waiting.set(id, resolve);
      transport.onmessage?.({ jsonrpc: '2.0', id, method, params });
    });
    if (reply.error || !reply.result) {
      return failFor(CALLER)(
        `could not read the server's ${method}: ${reply.error?.message ?? 'no result'}`,
      );
    }
    return reply.result;
  };

  try {
    await request('initialize', {
      protocolVersion: MEASURING_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CALLER, version: '0.0.0' },
    });
    transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools: Record<string, unknown>[] = [];
    let cursor: unknown;
    do {
      const page = await request('tools/list', cursor === undefined ? {} : { cursor });
      tools.push(...((page.tools as Record<string, unknown>[] | undefined) ?? []));
      cursor = page.nextCursor;
    } while (typeof cursor === 'string');
    return { tools };
  } finally {
    await server.close?.call(server).catch(() => undefined);
  }
}

function measureTool(tool: Record<string, unknown>): ToolMeasurement {
  return {
    name: String(tool.name),
    characters: serializedLength(tool),
    description: typeof tool.description === 'string' ? tool.description.length : 0,
    inputSchema: serializedLength(tool.inputSchema),
    outputSchema: serializedLength(tool.outputSchema),
    meta: serializedLength(tool._meta),
  };
}

/**
 * Measures a tool list the way a client receives it, to see what each tool costs a model's context and to hold the
 * list to a budget in a test. Character counts are of the JSON serialization: a tool's whole definition, its
 * `inputSchema`, `outputSchema` and `_meta`, and its description's length. The token count is approximate; see
 * `ToolListMeasurement.approximateTokens`.
 * @param input - A fresh MCP server, such as an MCP SDK 1.x or 2.x `McpServer` with its tools registered, which is
 * connected to an in-memory client, has every page of its tool list read, and is closed; or a `tools/list` result,
 * such as a client's `listTools()` returns from the deployed endpoint
 * @param options - See `MeasureToolListOptions`
 * @returns The measurement. It rejects with a `Clerk error:` for any other input, or when the server answers with an
 * error.
 * @example
 * ```ts
 * const { approximateTokens } = await measureToolList(createServer());
 * expect(approximateTokens).toBeLessThan(5000);
 * ```
 */
export async function measureToolList(
  input: MeasurableServer | ToolsListResult,
  options: MeasureToolListOptions | undefined = undefined,
): Promise<ToolListMeasurement> {
  const compactSchemas = readCompactSchemas(CALLER, options?.compactSchemas);
  let result: unknown = input;
  // An `McpServer` is a class instance, which `isPlainObject` rejects
  if (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { connect?: unknown }).connect === 'function'
  ) {
    result = await listTools(input as MeasurableServer, compactSchemas);
  }
  if (
    !isPlainObject(result) ||
    !Array.isArray(result.tools) ||
    !result.tools.every(isPlainObject)
  ) {
    return failFor(CALLER)(
      'takes an MCP server, such as new McpServer(...) with its tools registered, or a tools/list result such as client.listTools() returns',
    );
  }
  const tools = result.tools.map(measureTool);
  const sum = (key: 'description' | 'inputSchema' | 'outputSchema' | 'meta') =>
    tools.reduce((total, tool) => total + tool[key], 0);
  const characters = serializedLength(result);
  return {
    tools,
    totals: {
      characters,
      description: sum('description'),
      inputSchema: sum('inputSchema'),
      outputSchema: sum('outputSchema'),
      meta: sum('meta'),
    },
    approximateTokens: Math.ceil(characters / 4),
  };
}
