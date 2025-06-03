// @ts-ignore - better-sqlite3 is an optional peer dependency
import Database from "better-sqlite3";
import type { JsonSerializable } from "../client.js";
import path from "node:path";
import os from "node:os";

export interface SqliteStoreConfig {
  /**
   * Path to the SQLite database file
   * @default "~/.tmp/mcp-store.db"
   */
  dbPath?: string;
  /**
   * Table name for storing MCP data
   * @default "mcp_store"
   */
  tableName?: string;
  /**
   * Whether to enable WAL mode for better concurrency
   * @default true
   */
  enableWal?: boolean;
  /**
   * Whether to enable foreign key constraints
   * @default false
   */
  enableForeignKeys?: boolean;
  /**
   * Database timeout in milliseconds
   * @default 5000
   */
  timeout?: number;
  /**
   * Whether the database should be read-only
   * @default false
   */
  readonly?: boolean;
}

/**
 * Creates a SQLite store instance for MCP client data persistence
 *
 * @param config SQLite configuration
 * @returns Store object with read/write methods compatible with McpClientStore interface
 *
 * @example
 * ```typescript
 * import { createSqliteStore } from "@clerk/mcp-tools/stores/sqlite";
 *
 * const sqliteStore = createSqliteStore({
 *   dbPath: "./data/mcp-sessions.db",
 *   tableName: "sessions"
 * });
 * ```
 */
export function createSqliteStore(config: SqliteStoreConfig = {}) {
  // Check if better-sqlite3 is available
  if (!Database) {
    throw new Error(
      "better-sqlite3 package not found. Please install it with: npm install better-sqlite3 @types/better-sqlite3"
    );
  }

  const {
    dbPath = path.join(os.tmpdir(), "mcp-store.db"),
    tableName = "mcp_store",
    enableWal = true,
    enableForeignKeys = false,
    timeout = 5000,
    readonly = false,
  } = config;

  const db = new Database(dbPath, {
    readonly,
    timeout,
  });

  // Configure database
  if (enableWal) {
    db.pragma("journal_mode = WAL");
  }
  if (enableForeignKeys) {
    db.pragma("foreign_keys = ON");
  }

  // Create table if it doesn't exist
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createIndexSql = `
    CREATE INDEX IF NOT EXISTS idx_${tableName}_created_at 
    ON ${tableName} (created_at)
  `;

  db.exec(createTableSql);
  db.exec(createIndexSql);

  // Prepare statements for better performance
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO ${tableName} (key, value, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);

  const selectStmt = db.prepare(`
    SELECT value FROM ${tableName} WHERE key = ?
  `);

  const deleteStmt = db.prepare(`
    DELETE FROM ${tableName} WHERE key = ?
  `);

  const existsStmt = db.prepare(`
    SELECT 1 FROM ${tableName} WHERE key = ? LIMIT 1
  `);

  const keysStmt = db.prepare(`
    SELECT key FROM ${tableName} ORDER BY created_at
  `);

  const cleanupStmt = db.prepare(`
    DELETE FROM ${tableName} 
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `);

  const store = {
    write: async (k: string, v: JsonSerializable): Promise<void> => {
      insertStmt.run(k, JSON.stringify(v));
    },

    read: async (k: string): Promise<JsonSerializable> => {
      const row = selectStmt.get(k) as { value: string } | undefined;

      if (!row) {
        return null;
      }

      try {
        return JSON.parse(row.value);
      } catch (parseError) {
        throw new Error(
          `Failed to parse stored value for key "${k}": Invalid JSON`
        );
      }
    },

    /**
     * Delete a key from the store
     */
    delete: async (k: string): Promise<boolean> => {
      const result = deleteStmt.run(k);
      return result.changes > 0;
    },

    /**
     * Check if a key exists in the store
     */
    exists: async (k: string): Promise<boolean> => {
      const row = existsStmt.get(k);
      return row !== undefined;
    },

    /**
     * List all keys in the store (useful for debugging)
     */
    keys: async (): Promise<string[]> => {
      const rows = keysStmt.all() as { key: string }[];
      return rows.map((row) => row.key);
    },

    /**
     * Clean up old entries (older than specified days)
     */
    cleanup: async (olderThanDays: number = 30): Promise<number> => {
      const result = cleanupStmt.run(olderThanDays);
      return result.changes;
    },

    /**
     * Get database statistics
     */
    stats: async (): Promise<{
      totalKeys: number;
      dbSize: string;
      dbPath: string;
    }> => {
      const countResult = db
        .prepare(`SELECT COUNT(*) as count FROM ${tableName}`)
        .get() as { count: number };
      const sizeResult = db
        .prepare(
          "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()"
        )
        .get() as { size: number };

      return {
        totalKeys: countResult.count,
        dbSize: `${(sizeResult.size / 1024).toFixed(2)} KB`,
        dbPath: dbPath,
      };
    },

    /**
     * Close the SQLite connection
     */
    disconnect: async (): Promise<void> => {
      db.close();
    },
  };

  return store;
}
