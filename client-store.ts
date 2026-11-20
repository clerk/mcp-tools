// The store types `@clerk/mcp-tools/client` persists to, apart from `client.ts` so the stores' declarations do not import
// `@modelcontextprotocol/sdk`. `client.ts` re-exports them.

/**
 * A value a store can persist as JSON.
 */
export type JsonSerializable =
  | null
  | undefined
  | boolean
  | number
  | string
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

/**
 * A persistent key-value store for MCP client auth data.
 * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
 */
export interface McpClientStore {
  write: (key: string, value: JsonSerializable) => Promise<void>;
  read: (key: string) => Promise<JsonSerializable>;
  /**
   * Optional. Writes `value` to `key` only if the key still holds `expected`, a
   * value `read` returned for it, as one atomic step, and resolves whether it
   * wrote. Sessions are saved with it when it is present, so two processes
   * saving the same session at once cannot both bind it to an authorization
   * server: the later save sees the earlier binding and is checked against it.
   * Without it, a save reads and then writes, and the later of two overlapping
   * saves replaces the earlier one.
   */
  compareAndSet?: (
    key: string,
    expected: JsonSerializable,
    value: JsonSerializable,
  ) => Promise<boolean>;
}
