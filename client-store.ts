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
}
