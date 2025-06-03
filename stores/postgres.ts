// @ts-ignore - pg is an optional peer dependency
import pg from "pg";
import type { JsonSerializable } from "../client.js";

const { Client } = pg;

export interface PostgresStoreConfig {
  /**
   * PostgreSQL connection string
   * @example "postgresql://user:password@localhost:5432/database"
   */
  connectionString?: string;
  /**
   * PostgreSQL host
   * @default "localhost"
   */
  host?: string;
  /**
   * PostgreSQL port
   * @default 5432
   */
  port?: number;
  /**
   * PostgreSQL database name
   */
  database?: string;
  /**
   * PostgreSQL username
   */
  user?: string;
  /**
   * PostgreSQL password
   */
  password?: string;
  /**
   * Table name for storing MCP data
   * @default "mcp_store"
   */
  tableName?: string;
  /**
   * Enable SSL connection
   * @default false
   */
  ssl?: boolean;
  /**
   * Connection timeout in milliseconds
   * @default 5000
   */
  connectionTimeoutMillis?: number;
  /**
   * Idle timeout in milliseconds
   * @default 10000
   */
  idleTimeoutMillis?: number;
  /**
   * Maximum number of clients in the pool
   * @default 10
   */
  max?: number;
}

/**
 * Creates a PostgreSQL store instance for MCP client data persistence
 *
 * @param config PostgreSQL connection configuration
 * @returns Store object with read/write methods compatible with McpClientStore interface
 *
 * @example
 * ```typescript
 * import { createPostgresStore } from "@clerk/mcp-tools/stores/postgres";
 *
 * const postgresStore = createPostgresStore({
 *   host: "localhost",
 *   port: 5432,
 *   database: "myapp",
 *   user: "postgres",
 *   password: "password",
 *   tableName: "mcp_sessions"
 * });
 * ```
 */
export function createPostgresStore(config: PostgresStoreConfig = {}) {
  // Check if pg is available
  if (!pg) {
    throw new Error(
      "pg package not found. Please install it with: npm install pg @types/pg"
    );
  }

  const {
    connectionString,
    host = "localhost",
    port = 5432,
    database,
    user,
    password,
    tableName = "mcp_store",
    ssl = false,
    connectionTimeoutMillis = 5000,
    idleTimeoutMillis = 10000,
    max = 10,
  } = config;

  const clientConfig: any = connectionString
    ? { connectionString }
    : {
        host,
        port,
        database,
        user,
        password,
        ssl,
        connectionTimeoutMillis,
        idleTimeoutMillis,
        max,
      };

  const client = new Client(clientConfig);

  client.on("error", (err: Error) => {
    console.error("PostgreSQL Client Error:", err);
  });

  // Connect immediately and create table if it doesn't exist
  const initPromise = (async () => {
    await client.connect();

    // Create table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Create index on created_at for potential cleanup queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_${tableName}_created_at 
      ON ${tableName} (created_at)
    `);
  })();

  const store = {
    write: async (k: string, v: JsonSerializable): Promise<void> => {
      await initPromise; // Ensure connected and table exists

      const query = `
        INSERT INTO ${tableName} (key, value, updated_at) 
        VALUES ($1, $2, NOW()) 
        ON CONFLICT (key) 
        DO UPDATE SET value = $2, updated_at = NOW()
      `;

      await client.query(query, [k, JSON.stringify(v)]);
    },

    read: async (k: string): Promise<JsonSerializable> => {
      await initPromise; // Ensure connected and table exists

      const query = `SELECT value FROM ${tableName} WHERE key = $1`;
      const result = await client.query(query, [k]);

      if (result.rows.length === 0) {
        return null;
      }

      const value = result.rows[0].value;

      // If it's already a JavaScript object (JSONB does this automatically), return it
      if (typeof value === "object") {
        return value;
      }

      // Otherwise parse as JSON string
      try {
        return JSON.parse(value);
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
      await initPromise; // Ensure connected and table exists

      const query = `DELETE FROM ${tableName} WHERE key = $1`;
      const result = await client.query(query, [k]);

      return result.rowCount > 0;
    },

    /**
     * Check if a key exists in the store
     */
    exists: async (k: string): Promise<boolean> => {
      await initPromise; // Ensure connected and table exists

      const query = `SELECT 1 FROM ${tableName} WHERE key = $1`;
      const result = await client.query(query, [k]);

      return result.rows.length > 0;
    },

    /**
     * List all keys in the store (useful for debugging)
     */
    keys: async (): Promise<string[]> => {
      await initPromise; // Ensure connected and table exists

      const query = `SELECT key FROM ${tableName} ORDER BY created_at`;
      const result = await client.query(query);

      return result.rows.map((row: { key: string }) => row.key);
    },

    /**
     * Clean up old entries (older than specified days)
     */
    cleanup: async (olderThanDays: number = 30): Promise<number> => {
      await initPromise; // Ensure connected and table exists

      const query = `
        DELETE FROM ${tableName} 
        WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'
      `;
      const result = await client.query(query);

      return result.rowCount;
    },

    /**
     * Get PostgreSQL store statistics
     */
    stats: async (): Promise<{
      totalKeys: number;
      tableSize: string;
      dbInfo: string;
    }> => {
      await initPromise; // Ensure connected and table exists

      let totalKeys = 0;
      let tableSize = "N/A";
      let dbInfo = "N/A";

      try {
        // Get total number of keys
        const countResult = await client.query(
          `SELECT COUNT(*) as count FROM ${tableName}`
        );
        totalKeys = parseInt(countResult.rows[0].count);

        // Get table size
        const sizeResult = await client.query(`
          SELECT pg_size_pretty(pg_total_relation_size('${tableName}')) as size
        `);
        if (sizeResult.rows.length > 0) {
          tableSize = sizeResult.rows[0].size;
        }

        // Get PostgreSQL version
        const versionResult = await client.query("SELECT version()");
        if (versionResult.rows.length > 0) {
          const version = versionResult.rows[0].version;
          const match = version.match(/PostgreSQL ([\d.]+)/);
          if (match) {
            dbInfo = `PostgreSQL ${match[1]}`;
          }
        }
      } catch (error) {
        // Stats not available, keep defaults
      }

      return {
        totalKeys,
        tableSize,
        dbInfo,
      };
    },

    /**
     * Close the PostgreSQL connection
     */
    disconnect: async (): Promise<void> => {
      await client.end();
    },
  };

  return store;
}
