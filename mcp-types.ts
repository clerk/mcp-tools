// Local copies of the MCP SDK types this package's declarations use, so the entrypoints that only need types do not
// import `@modelcontextprotocol/sdk`, an optional peer that apps on MCP SDK 2.x (`@modelcontextprotocol/server`) do not
// install. Keep them structurally identical to the SDK's, including the optional keys, so the SDK's types and these
// are assignable to each other on SDK 1.x and 2.x.

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
