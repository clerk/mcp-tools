import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'client.ts',
    'server.ts',
    'tools.ts',
    'next/index.ts',
    'next/client.ts',
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
  // Keep real names on exports between chunks, so editors and declarations show `McpAuthError`, not `i`
  outputOptions: { minifyInternalExports: false },
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
      // Types only. Inlined, its classes' protected members make the app's own ClerkClient fail the clerkClient option
      /^@clerk\/backend(\/|$)/,
    ],
  },
});
