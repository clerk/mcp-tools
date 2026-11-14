// Local copies of the MCP SDK types this package's declarations use, so the entrypoints that only need types do not
// import `@modelcontextprotocol/sdk`, an optional peer that apps on MCP SDK 2.x (`@modelcontextprotocol/server`) do not
// install. Keep them structurally identical to the SDK's, including the optional keys, so the SDK's types and these
// are assignable to each other on SDK 1.x and 2.x. The server entrypoints also take the SDK classes they run, such as
// the streamable HTTP transport, as arguments instead of importing them, so they never import the SDK at all.

/**
 * Information about a validated access token, as MCP SDK 1.x (`@modelcontextprotocol/sdk/server/auth/types.js`) and
 * 2.x (`@modelcontextprotocol/server`) define it. SDK 2.x adds `resourceMetadataUrl`, which a value from either SDK
 * may carry.
 */
export interface AuthInfo {
  /**
   * The access token.
   */
  token: string;
  /**
   * The client ID associated with this token.
   */
  clientId: string;
  /**
   * Scopes associated with this token.
   */
  scopes: string[];
  /**
   * When the token expires, in seconds since the epoch.
   */
  expiresAt?: number;
  /**
   * The RFC 8707 resource server identifier the token is valid for.
   */
  resource?: URL;
  /**
   * Additional data attached to the token.
   */
  extra?: Record<string, unknown>;
}

/**
 * The part of an MCP SDK `McpServer` that `streamableHttpHandler` uses: connecting it to a transport.
 * @typeParam Transport - The transport the server connects to
 */
export interface McpServerLike<Transport> {
  /**
   * Connects the server to a transport and starts listening for messages on it.
   * @param transport - The transport to connect to
   * @returns A promise that resolves once the server is connected
   */
  connect(transport: Transport): Promise<void>;
}

/**
 * A streamable HTTP server transport class from the MCP SDK, such as `StreamableHTTPServerTransport` or
 * `WebStandardStreamableHTTPServerTransport`. `streamableHttpHandler` creates one per request, in stateless mode.
 * @typeParam Transport - The transport the class creates
 */
export type StreamableHttpTransportClass<Transport> = new (options: {
  sessionIdGenerator: undefined;
}) => Transport;

/**
 * Hints about a tool's behavior, as the MCP SDK's `ToolAnnotations` defines them.
 */
export type ToolAnnotations = {
  /**
   * A human-readable title for the tool.
   */
  title?: string;
  /**
   * Whether the tool leaves its environment unchanged.
   */
  readOnlyHint?: boolean;
  /**
   * Whether the tool may perform destructive updates.
   */
  destructiveHint?: boolean;
  /**
   * Whether calling the tool again with the same arguments has no further effect.
   */
  idempotentHint?: boolean;
  /**
   * Whether the tool interacts with an open world of external entities.
   */
  openWorldHint?: boolean;
};
