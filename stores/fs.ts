import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonSerializable } from "../client.js";

export interface FsStoreConfig {
  /**
   * Path to the store file
   * @default "~/.tmp/__mcp_demo"
   */
  filePath?: string;
}

/**
 * Creates a file system store instance for MCP client data persistence
 *
 * @param config File system store configuration
 * @returns Store object with read/write methods compatible with McpClientStore interface
 *
 * @example
 * ```typescript
 * import { createFsStore } from "@clerk/mcp-tools/stores/fs";
 *
 * const fsStore = createFsStore({
 *   filePath: "./data/mcp-sessions.json"
 * });
 * ```
 */
export function createFsStore(config: FsStoreConfig = {}) {
  const { filePath = path.join(os.tmpdir(), "__mcp_demo") } = config;

  // Ensure the directory exists
  const ensureDirectoryExists = async () => {
    const dir = path.dirname(filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
    }
  };

  const readStoreData = async (): Promise<{ [key: string]: any }> => {
    try {
      if (!fsSync.existsSync(filePath)) {
        await ensureDirectoryExists();
        await fs.writeFile(filePath, "{}");
        return {};
      }
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      // If file is corrupted, start fresh
      await ensureDirectoryExists();
      await fs.writeFile(filePath, "{}");
      return {};
    }
  };

  const writeStoreData = async (data: {
    [key: string]: any;
  }): Promise<void> => {
    await ensureDirectoryExists();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  };

  const store = {
    write: async (k: string, v: JsonSerializable): Promise<void> => {
      const data = await readStoreData();
      data[k] = {
        value: v,
        created_at: data[k]?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await writeStoreData(data);
    },

    read: async (k: string): Promise<JsonSerializable> => {
      const data = await readStoreData();
      const entry = data[k];
      return entry ? entry.value : null;
    },

    /**
     * Delete a key from the store
     */
    delete: async (k: string): Promise<boolean> => {
      const data = await readStoreData();
      if (k in data) {
        delete data[k];
        await writeStoreData(data);
        return true;
      }
      return false;
    },

    /**
     * Check if a key exists in the store
     */
    exists: async (k: string): Promise<boolean> => {
      const data = await readStoreData();
      return k in data;
    },

    /**
     * List all keys in the store (useful for debugging)
     */
    keys: async (): Promise<string[]> => {
      const data = await readStoreData();
      return Object.keys(data).sort((a, b) => {
        const aTime = new Date(data[a].created_at).getTime();
        const bTime = new Date(data[b].created_at).getTime();
        return aTime - bTime;
      });
    },

    /**
     * Clean up old entries (older than specified days)
     */
    cleanup: async (olderThanDays: number = 30): Promise<number> => {
      const data = await readStoreData();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      let deleteCount = 0;
      for (const [key, entry] of Object.entries(data)) {
        const createdAt = new Date(entry.created_at);
        if (createdAt < cutoffDate) {
          delete data[key];
          deleteCount++;
        }
      }

      if (deleteCount > 0) {
        await writeStoreData(data);
      }

      return deleteCount;
    },

    /**
     * Get file system store statistics
     */
    stats: async (): Promise<{
      totalKeys: number;
      fileSize: string;
      filePath: string;
    }> => {
      const data = await readStoreData();
      let fileSize = "0 B";

      try {
        if (fsSync.existsSync(filePath)) {
          const stats = await fs.stat(filePath);
          const bytes = stats.size;
          if (bytes < 1024) {
            fileSize = `${bytes} B`;
          } else if (bytes < 1024 * 1024) {
            fileSize = `${(bytes / 1024).toFixed(2)} KB`;
          } else {
            fileSize = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
          }
        }
      } catch (error) {
        // Stats not available
      }

      return {
        totalKeys: Object.keys(data).length,
        fileSize,
        filePath,
      };
    },

    /**
     * No-op for file system store (no connection to close)
     */
    disconnect: async (): Promise<void> => {
      // No-op for file system store
    },
  };

  return store;
}

// Export default for backward compatibility
const fsStore = createFsStore();
export default fsStore;
