// @ts-ignore - Redis is an optional peer dependency
import Redis from "redis";
import type { JsonSerializable } from "../client.js";

export interface RedisStoreConfig {
  /**
   * Redis host
   * @default "localhost"
   */
  host?: string;
  /**
   * Redis port
   * @default 6379
   */
  port?: number;
  /**
   * Redis password for authentication
   */
  password?: string;
  /**
   * Redis database number
   * @default 0
   */
  db?: number;
  /**
   * Key prefix for all stored keys to avoid conflicts
   * @default "mcp:"
   */
  keyPrefix?: string;
  /**
   * Connection timeout in milliseconds
   * @default 5000
   */
  connectTimeout?: number;
  /**
   * TTL for stored keys in seconds (optional)
   * If not set, keys will persist indefinitely
   */
  ttl?: number;
  /**
   * Enable TLS connection
   * @default false
   */
  tls?: boolean;
}

/**
 * Creates a Redis store instance for MCP client data persistence
 *
 * @param config Redis connection configuration
 * @returns Store object with read/write methods compatible with McpClientStore interface
 *
 * @example
 * ```typescript
 * import { createRedisStore } from "@clerk/mcp-tools/stores/redis";
 *
 * const redisStore = createRedisStore({
 *   host: "localhost",
 *   port: 6379,
 *   password: "your-redis-password",
 *   keyPrefix: "myapp:mcp:",
 *   ttl: 3600 // 1 hour
 * });
 * ```
 */
export function createRedisStore(config: RedisStoreConfig = {}) {
  // Check if Redis is available
  if (!Redis) {
    throw new Error(
      "Redis package not found. Please install it with: npm install redis@^4.0.0"
    );
  }

  const {
    host = "localhost",
    port = 6379,
    password,
    db = 0,
    keyPrefix = "mcp:",
    connectTimeout = 5000,
    ttl,
    tls = false,
  } = config;

  const redisConfig: any = {
    socket: {
      host,
      port,
      connectTimeout,
      tls: tls ? {} : false,
    },
    database: db,
  };

  if (password) {
    redisConfig.password = password;
  }

  const redis = Redis.createClient(redisConfig);

  redis.on("error", (err: Error) => {
    console.error("Redis Client Error:", err);
  });

  const formatKey = (key: string): string => `${keyPrefix}${key}`;

  // Connect immediately
  const connectionPromise = redis.connect();

  const store = {
    write: async (k: string, v: JsonSerializable): Promise<void> => {
      await connectionPromise; // Ensure connected
      const serializedValue = JSON.stringify({
        value: v,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const key = formatKey(k);

      if (ttl) {
        await redis.setEx(key, ttl, serializedValue);
      } else {
        await redis.set(key, serializedValue);
      }
    },

    read: async (k: string): Promise<JsonSerializable> => {
      await connectionPromise; // Ensure connected
      const key = formatKey(k);
      const value = await redis.get(key);

      if (value === null) {
        return null;
      }

      try {
        const parsed = JSON.parse(value);
        // Return the actual value, not the wrapper object
        return parsed.value !== undefined ? parsed.value : parsed;
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
      await connectionPromise; // Ensure connected
      const key = formatKey(k);
      const result = await redis.del(key);
      return result > 0;
    },

    /**
     * Check if a key exists in the store
     */
    exists: async (k: string): Promise<boolean> => {
      await connectionPromise; // Ensure connected
      const key = formatKey(k);
      const result = await redis.exists(key);
      return result === 1;
    },

    /**
     * List all keys in the store (useful for debugging)
     */
    keys: async (): Promise<string[]> => {
      await connectionPromise; // Ensure connected
      const pattern = `${keyPrefix}*`;
      const keys = await redis.keys(pattern);

      // Remove the prefix from keys and sort by creation time if possible
      const unprefixedKeys = keys.map((key) => key.substring(keyPrefix.length));

      // Try to sort by creation time
      try {
        const keysWithTimes = await Promise.all(
          unprefixedKeys.map(async (key) => {
            try {
              const value = await redis.get(formatKey(key));
              if (value) {
                const parsed = JSON.parse(value);
                return {
                  key,
                  created_at: parsed.created_at || new Date(0).toISOString(),
                };
              }
            } catch {
              // If parsing fails, use epoch time
            }
            return { key, created_at: new Date(0).toISOString() };
          })
        );

        return keysWithTimes
          .sort(
            (a, b) =>
              new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime()
          )
          .map((item) => item.key);
      } catch {
        // If sorting fails, return unsorted
        return unprefixedKeys;
      }
    },

    /**
     * Clean up old entries (older than specified days)
     * Note: This requires scanning all keys, which can be expensive for large datasets
     */
    cleanup: async (olderThanDays: number = 30): Promise<number> => {
      await connectionPromise; // Ensure connected
      const pattern = `${keyPrefix}*`;
      const keys = await redis.keys(pattern);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      let deleteCount = 0;

      for (const key of keys) {
        try {
          const value = await redis.get(key);
          if (value) {
            const parsed = JSON.parse(value);
            const createdAt = new Date(parsed.created_at || 0);
            if (createdAt < cutoffDate) {
              const deleted = await redis.del(key);
              if (deleted > 0) {
                deleteCount++;
              }
            }
          }
        } catch {
          // If we can't parse the value, skip it
        }
      }

      return deleteCount;
    },

    /**
     * Get Redis store statistics
     */
    stats: async (): Promise<{
      totalKeys: number;
      memoryUsage: string;
      redisInfo: string;
    }> => {
      await connectionPromise; // Ensure connected
      const pattern = `${keyPrefix}*`;
      const keys = await redis.keys(pattern);

      let memoryUsage = "N/A";
      let redisInfo = "N/A";

      try {
        // Get Redis info for memory usage
        const info = await redis.info("memory");
        const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
        if (memoryMatch) {
          memoryUsage = memoryMatch[1].trim();
        }

        // Get basic Redis info
        const serverInfo = await redis.info("server");
        const versionMatch = serverInfo.match(/redis_version:([^\r\n]+)/);
        if (versionMatch) {
          redisInfo = `Redis ${versionMatch[1].trim()}`;
        }
      } catch {
        // Stats not available
      }

      return {
        totalKeys: keys.length,
        memoryUsage,
        redisInfo,
      };
    },

    /**
     * Close the Redis connection
     */
    disconnect: async (): Promise<void> => {
      await redis.disconnect();
    },
  };

  return store;
}
