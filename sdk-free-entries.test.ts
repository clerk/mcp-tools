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

function sdkImports(entry: string, packagePrefix = '@modelcontextprotocol/sdk') {
  return reachableFiles(entry).flatMap((file) =>
    importedSpecifiers(file)
      .filter((specifier) => specifier.startsWith(packagePrefix))
      .map((specifier) => `${relative(file)} imports ${specifier}`),
  );
}

describe('server entry points', () => {
  test.each(SERVER_ENTRIES)('%s does not import @modelcontextprotocol/sdk', (entry) => {
    expect(sdkImports(entry)).toEqual([]);
  });

  // Public discovery needs no schema validator, Clerk package, or MCP SDK: the Server Card and AI Catalog modules
  // import only other package files
  test('the discovery modules import no package at all', () => {
    const packages = reachableFiles('discovery-response.ts').flatMap((file) =>
      importedSpecifiers(file)
        .filter((specifier) => !specifier.startsWith('.'))
        .map((specifier) => `${relative(file)} imports ${specifier}`),
    );
    expect(packages).toEqual([]);
  });

  // `createClerkMcpWorker` in the fetch entry is built on MCP SDK 2.x; the wrapper stays usable without any MCP SDK
  test('clerkInstrumentHandler from the fetch entry imports no MCP SDK package', () => {
    expect(sdkImports('fetch/instrument-handler.ts', '@modelcontextprotocol/')).toEqual([]);
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
function runtimeImports(entry: string, packagePrefix: string) {
  return reachableFiles(entry).flatMap((file) =>
    ts
      .createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
      .statements.flatMap((statement) => {
        const isImport = ts.isImportDeclaration(statement);
        if (!isImport && !ts.isExportDeclaration(statement)) return [];
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) return [];
        if (!specifier.text.startsWith(packagePrefix)) return [];
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
vi.mock('@clerk/nextjs/server', () => {
  clerkLoads.push('@clerk/nextjs/server');
  throw new Error('Cannot find package @clerk/nextjs');
});
vi.mock('@clerk/express', () => {
  clerkLoads.push('@clerk/express');
  throw new Error('Cannot find package @clerk/express');
});

// MCP SDK 2.x is an optional peer too: `createClerkMcpWorker` loads it with `import()` inside `try`, so a Worker that
// only uses the fetch entry's `clerkInstrumentHandler` need not install it
const sdkLoads = vi.hoisted(() => [] as string[]);
vi.mock('@modelcontextprotocol/server', () => {
  sdkLoads.push('@modelcontextprotocol/server');
  throw new Error('Cannot find package @modelcontextprotocol/server');
});

// The fetch entry's request: a POST with a token `verifyToken` accepts, an empty Worker env, and a no-op ctx
const verifyToken = async () => ({
  token: 'token-1',
  clientId: 'client-1',
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});
const bearerPost = () =>
  new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer token-1' },
  });
const workerCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

describe('the fetch entry without MCP SDK 2.x', () => {
  test('fetch/index.ts has no top-level runtime import from an MCP SDK package', () => {
    expect(runtimeImports('fetch/index.ts', '@modelcontextprotocol/')).toEqual([]);
  });

  test('the runtime import scan finds an MCP SDK import where there is one', () => {
    expect(runtimeImports('test/discover-conformance.test.ts', '@modelcontextprotocol/')).toContain(
      'test/discover-conformance.test.ts imports @modelcontextprotocol/server',
    );
  });

  test('createClerkMcpWorker asks to install @modelcontextprotocol/server when it can not be loaded', async () => {
    const { createClerkMcpWorker } = await import('./fetch/index');
    const worker = createClerkMcpWorker({
      verifyToken,
      server: () => {
        throw new Error('not reached');
      },
    });

    try {
      await expect(worker.fetch(bearerPost(), {}, workerCtx)).rejects.toThrow(
        'Clerk error: install @modelcontextprotocol/server',
      );
      expect(sdkLoads).toContain('@modelcontextprotocol/server');
    } finally {
      sdkLoads.length = 0;
    }
  });
});

describe('the adapter entry points without Clerk packages', () => {
  test.each(['hono/index.ts', 'next/index.ts', 'express/index.ts', 'fetch/index.ts'])(
    '%s has no top-level runtime import from a Clerk package',
    (entry) => {
      expect(runtimeImports(entry, '@clerk/')).toEqual([]);
    },
  );

  test('the runtime import scan finds a Clerk import where there is one', () => {
    expect(runtimeImports('clerk-verification.test.ts', '@clerk/')).toContain(
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

  test('loads, and serves a request with the fetch clerkInstrumentHandler(handler, { verifyToken }), without loading a Clerk package', async () => {
    const { clerkInstrumentHandler } = await import('./fetch/index');
    const authedHandler = clerkInstrumentHandler(
      (_request, { authInfo }) => Response.json({ clientId: authInfo?.clientId }),
      { verifyToken },
    );

    const res = await authedHandler(bearerPost(), {}, workerCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientId: 'client-1' });
    expect(clerkLoads).toEqual([]);
    expect(sdkLoads).toEqual([]);
  });

  test('serves a Server Card with serverCardHandler without loading a Clerk package', async () => {
    const { Hono } = await import('hono');
    const { serverCardHandler } = await import('./hono/index');
    const app = new Hono();
    app.all(
      '/mcp/server-card',
      serverCardHandler({
        name: 'com.example/weather',
        version: '1.2.0',
        description: 'Forecasts.',
        resourceUrl: 'https://mcp.example.com/mcp',
      }),
    );

    const res = await app.request('https://mcp.example.com/mcp/server-card', {
      headers: { Authorization: 'Bearer token-1' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'com.example/weather' });
    expect(clerkLoads).toEqual([]);
  });

  test('serves an AI Catalog with aiCatalogHandler without loading a Clerk package', async () => {
    const { Hono } = await import('hono');
    const { aiCatalogHandler } = await import('./hono/index');
    const app = new Hono();
    app.all(
      '/.well-known/ai-catalog.json',
      aiCatalogHandler({
        entries: [
          {
            identifier: 'urn:air:example.com:weather:mcp',
            displayName: 'Weather',
            url: 'https://mcp.example.com/mcp/server-card',
          },
        ],
      }),
    );

    const res = await app.request('https://mcp.example.com/.well-known/ai-catalog.json', {
      headers: { Authorization: 'Bearer token-1' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ specVersion: '0.9' });
    expect(clerkLoads).toEqual([]);
  });

  test('serves a Server Card and an AI Catalog from Next.js routes without loading a Clerk package', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    vi.stubEnv('CLERK_SECRET_KEY', '');
    const { aiCatalogHandler, serverCardHandler } = await import('./next/index');
    const cardRoute = serverCardHandler({
      name: 'com.example/weather',
      version: '1.2.0',
      description: 'Forecasts.',
      resourceUrl: 'https://mcp.example.com/mcp',
    });
    const catalogRoute = aiCatalogHandler({
      entries: [
        {
          identifier: 'urn:air:example.com:weather:mcp',
          displayName: 'Weather',
          url: 'https://mcp.example.com/mcp/server-card',
        },
      ],
    });
    const headers = { Authorization: 'Bearer token-1' };

    const card = cardRoute(new Request('https://mcp.example.com/mcp/server-card', { headers }));
    const catalog = catalogRoute(
      new Request('https://mcp.example.com/.well-known/ai-catalog.json', { headers }),
    );

    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({ name: 'com.example/weather' });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ specVersion: '0.9' });
    expect(clerkLoads).toEqual([]);
    vi.unstubAllEnvs();
  });

  // The control for the test above: the Next.js Clerk path does load the mocked package, so its absence is recorded
  test('records a load of @clerk/nextjs/server where the Next.js entry loads it', async () => {
    const { withClerkMcpAuth } = await import('./next/index');
    const route = withClerkMcpAuth(() => new Response('reached'), {
      resourceUrl: 'https://mcp.example.com/mcp',
    });

    try {
      await route(
        new Request('https://mcp.example.com/mcp', {
          method: 'POST',
          headers: { Authorization: 'Bearer token-1' },
        }),
      ).catch(() => undefined);

      expect(clerkLoads).toContain('@clerk/nextjs/server');
    } finally {
      // So a later test that expects no loads starts from none
      clerkLoads.length = 0;
    }
  });

  test('serves a Server Card and an AI Catalog through Express without loading a Clerk package', async () => {
    const { default: express } = await import('express');
    const { withListening } = await import('./test/mcp-harness');
    const { aiCatalogHandler, serverCardHandler } = await import('./express/index');
    const app = express();
    app.all(
      '/mcp/server-card',
      serverCardHandler({
        name: 'com.example/weather',
        version: '1.2.0',
        description: 'Forecasts.',
        resourceUrl: 'https://mcp.example.com/mcp',
      }),
    );
    app.all(
      '/.well-known/ai-catalog.json',
      aiCatalogHandler({
        entries: [
          {
            identifier: 'urn:air:example.com:weather:mcp',
            displayName: 'Weather',
            url: 'https://mcp.example.com/mcp/server-card',
          },
        ],
      }),
    );

    const [cardBody, catalogBody] = await withListening(app, (baseUrl) =>
      Promise.all(
        ['/mcp/server-card', '/.well-known/ai-catalog.json'].map(async (path) => {
          const res = await fetch(`${baseUrl}${path}`, {
            headers: { Authorization: 'Bearer token-1' },
          });
          expect(res.status).toBe(200);
          return res.json();
        }),
      ),
    );

    expect(cardBody).toMatchObject({ name: 'com.example/weather' });
    expect(catalogBody).toMatchObject({ specVersion: '0.9' });
    expect(clerkLoads).toEqual([]);
  });
});
