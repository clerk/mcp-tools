import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test, vi } from 'vitest';

// `@modelcontextprotocol/sdk` is an optional peer that apps on MCP SDK 2.x do not install. A bundler resolves every
// import it finds, including lazy `import()` calls and imports in code the app never runs, so a reference to the SDK
// anywhere in a server entry point fails the app's build. Type-only imports would also leave the published
// declarations pointing at a package the app may not have. These entry points must not reach the SDK at all.
const SERVER_ENTRIES = [
  'server.ts',
  'tools.ts',
  'next/index.ts',
  'express/index.ts',
  'hono/index.ts',
  'stores/fs.ts',
  'stores/redis.ts',
  'stores/postgres.ts',
  'stores/sqlite.ts',
];

const root = dirname(fileURLToPath(import.meta.url));

// TypeScript's own scan: static, type-only, and dynamic imports and re-exports, but not import examples in comments or
// strings
function importedSpecifiers(file: string) {
  return ts
    .preProcessFile(readFileSync(file, 'utf8'), true, true)
    .importedFiles.map(({ fileName }) => fileName);
}

function resolveLocal(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  return [`${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate));
}

// Every module specifier reachable from `entry` through the package's own files, mapped to the file that imports it
function reachableSpecifiers(entry: string) {
  const specifiers = new Map<string, string>();
  const seen = new Set<string>();
  const pending = [join(root, entry)];

  for (let file = pending.pop(); file; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of importedSpecifiers(file)) {
      if (!specifier.startsWith('.')) {
        specifiers.set(specifier, file.slice(root.length + 1));
        continue;
      }
      const local = resolveLocal(file, specifier);
      if (local) pending.push(local);
    }
  }

  return specifiers;
}

describe('server entry points', () => {
  test.each(SERVER_ENTRIES)('%s does not import @modelcontextprotocol/sdk', (entry) => {
    const sdkImports = [...reachableSpecifiers(entry)]
      .filter(([specifier]) => specifier.startsWith('@modelcontextprotocol/sdk'))
      .map(([specifier, file]) => `${file} imports ${specifier}`);

    expect(sdkImports).toEqual([]);
  });

  // `@clerk/nextjs` is an optional peer too, and webpack fails the build of an app without it on any reference to it,
  // so `withMcpAuth` takes `clerkClient` from the app instead of importing it
  test('next/index.ts does not import @clerk/nextjs', () => {
    expect(
      [...reachableSpecifiers('next/index.ts').keys()].filter((s) => s.startsWith('@clerk/nextjs')),
    ).toEqual([]);
  });

  test('the import scan finds the SDK where it is used', () => {
    expect([...reachableSpecifiers('client.ts').keys()]).toContain(
      '@modelcontextprotocol/sdk/client/index.js',
    );
  });
});

// Every Clerk package is an optional peer of the Hono entry: an app that verifies tokens with `verifyToken` may have
// none. So the entry only imports types from them, and loads `@clerk/backend` with `import()` inside `try` when it
// builds a Clerk client from the environment, which a bundler leaves to fail at run time instead of failing the build.
function runtimeClerkImports(entry: string) {
  const found: string[] = [];
  const seen = new Set<string>();
  const pending = [join(root, entry)];

  for (let file = pending.pop(); file; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);

    for (const statement of source.statements) {
      const isImport = ts.isImportDeclaration(statement);
      if (!isImport && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;

      if (specifier.text.startsWith('.')) {
        const local = resolveLocal(file, specifier.text);
        if (local) pending.push(local);
        continue;
      }
      const typeOnly = isImport
        ? statement.importClause?.isTypeOnly ||
          (statement.importClause?.namedBindings &&
            !statement.importClause.name &&
            ts.isNamedImports(statement.importClause.namedBindings) &&
            statement.importClause.namedBindings.elements.every((element) => element.isTypeOnly))
        : statement.isTypeOnly;
      if (specifier.text.startsWith('@clerk/') && !typeOnly) {
        found.push(`${file.slice(root.length + 1)} imports ${specifier.text}`);
      }
    }
  }

  return found;
}

const clerkLoads = vi.hoisted(() => [] as string[]);
vi.mock('@clerk/backend', () => {
  clerkLoads.push('@clerk/backend');
  throw new Error('Cannot find package @clerk/backend');
});
vi.mock('@clerk/hono', () => {
  clerkLoads.push('@clerk/hono');
  throw new Error('Cannot find package @clerk/hono');
});

describe('hono/index.ts without Clerk packages', () => {
  test('has no top-level runtime import from a Clerk package', () => {
    expect(runtimeClerkImports('hono/index.ts')).toEqual([]);
  });

  test('the runtime import scan finds a Clerk import where there is one', () => {
    expect(runtimeClerkImports('express/index.ts')).toEqual([
      'express/index.ts imports @clerk/express',
    ]);
  });

  test('loads, and serves a request with mcpAuth({ verifyToken }), without loading a Clerk package', async () => {
    const { Hono } = await import('hono');
    const { mcpAuth } = await import('./hono/index');
    const app = new Hono();
    app.post(
      '/mcp',
      mcpAuth({
        verifyToken: async () => ({ token: 'token-1', clientId: 'client-1', scopes: [] }),
      }),
      (c) => c.json({ clientId: c.get('mcpAuth').clientId }),
    );

    const res = await app.request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientId: 'client-1' });
    expect(clerkLoads).toEqual([]);
  });
});
