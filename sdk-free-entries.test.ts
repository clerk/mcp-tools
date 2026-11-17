import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test, vi } from 'vitest';

// `@modelcontextprotocol/sdk` is an optional peer that apps on MCP SDK 2.x do not install. A bundler resolves every
// import it finds, including lazy `import()` calls and imports in code the app never runs, so a reference to the SDK
// anywhere in a server entry point fails the app's build. Type-only imports would also leave the published
// declarations pointing at a package the app may not have. These entry points must not reach the SDK at all.
const root = dirname(fileURLToPath(import.meta.url));

// Every built entry in the `exports` map but the two client ones, which are built on the SDK
const SERVER_ENTRIES = Object.values(
  (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    }
  ).exports,
)
  .flatMap((target) => (typeof target === 'object' ? [(target as { import: string }).import] : []))
  .map((built) => built.replace(/^\.\/dist\/(.+)\.mjs$/, '$1.ts'))
  .filter((entry) => !entry.endsWith('client.ts'));

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

// Every package file reachable from `entry` through relative imports
function reachableFiles(entry: string) {
  const seen = new Set<string>();
  const pending = [join(root, entry)];
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importedSpecifiers(file)) {
      const local = specifier.startsWith('.') ? resolveLocal(file, specifier) : undefined;
      if (local) pending.push(local);
    }
  }
  return [...seen];
}

const relative = (file: string) => file.slice(root.length + 1);

function sdkImports(entry: string) {
  return reachableFiles(entry).flatMap((file) =>
    importedSpecifiers(file)
      .filter((specifier) => specifier.startsWith('@modelcontextprotocol/sdk'))
      .map((specifier) => `${relative(file)} imports ${specifier}`),
  );
}

describe('server entry points', () => {
  test.each(SERVER_ENTRIES)('%s does not import @modelcontextprotocol/sdk', (entry) => {
    expect(sdkImports(entry)).toEqual([]);
  });

  test('the import scan finds the SDK where it is used', () => {
    expect(sdkImports('client.ts')).toContain(
      'client.ts imports @modelcontextprotocol/sdk/client/index.js',
    );
  });
});

// Every Clerk package is an optional peer of the Express, Hono, and Next.js entries: an app that verifies tokens with
// `verifyToken` may have none. So the entries only import types from them, and load their default client's package
// (`@clerk/express` in Express, `@clerk/backend` in Hono, `@clerk/nextjs` in Next.js) with `import()` inside `try`,
// which webpack, Turbopack, and esbuild leave to fail at run time with at most a warning, where a bare reference would
// fail the build.
function runtimeClerkImports(entry: string) {
  return reachableFiles(entry).flatMap((file) =>
    ts
      .createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
      .statements.flatMap((statement) => {
        const isImport = ts.isImportDeclaration(statement);
        if (!isImport && !ts.isExportDeclaration(statement)) return [];
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) return [];
        if (!specifier.text.startsWith('@clerk/')) return [];
        const clause = isImport ? statement.importClause : undefined;
        const typeOnly = isImport
          ? clause?.isTypeOnly ||
            (clause?.namedBindings &&
              !clause.name &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.every((element) => element.isTypeOnly))
          : statement.isTypeOnly;
        return typeOnly ? [] : [`${relative(file)} imports ${specifier.text}`];
      }),
  );
}

const clerkLoads = vi.hoisted(() => [] as string[]);
vi.mock('@clerk/backend', () => {
  clerkLoads.push('@clerk/backend');
  throw new Error('Cannot find package @clerk/backend');
});

describe('the adapter entry points without Clerk packages', () => {
  test.each(['hono/index.ts', 'next/index.ts', 'express/index.ts'])(
    '%s has no top-level runtime import from a Clerk package',
    (entry) => {
      expect(runtimeClerkImports(entry)).toEqual([]);
    },
  );

  test('the runtime import scan finds a Clerk import where there is one', () => {
    expect(runtimeClerkImports('clerk-verification.test.ts')).toContain(
      'clerk-verification.test.ts imports @clerk/backend',
    );
  });

  test('loads, and serves a request with mcpAuth({ verifyToken }), without loading a Clerk package', async () => {
    const { Hono } = await import('hono');
    const { mcpAuth } = await import('./hono/index');
    const app = new Hono();
    app.post(
      '/mcp',
      mcpAuth({
        verifyToken: async () => ({
          token: 'token-1',
          clientId: 'client-1',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      }),
      (c) => c.json({ clientId: c.get('mcpAuth')?.clientId }),
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
