import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'client.ts',
    'server.ts',
    'next/index.ts',
    'express/index.ts',
    'hono/index.ts',
    'stores/fs.ts',
    'stores/redis.ts',
    'stores/postgres.ts',
    'stores/sqlite.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      'redis',
      'pg',
      'better-sqlite3',
      'next',
      '@clerk/express',
      '@clerk/nextjs',
      'express',
      'hono',
      '@clerk/hono',
    ],
  },
});
