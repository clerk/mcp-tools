import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// The exact public surface of every subpath in the `exports` map. A change to any entry point's exports must change
// this list in the same commit, so the surface only ever changes on purpose. `null` pins a subpath that has no entry
// module to export from.
type Surface = { values: string[]; types: string[] } | null;

const PINNED: Record<string, Surface> = {
  './client': {
    values: [
      'completeOAuth',
      'createDynamicallyRegisteredMcpClient',
      'createKnownCredentialsMcpClient',
      'getMcpClientBySessionId',
    ],
    types: [
      'CreateDynamicallyRegisteredMcpClientOptions',
      'CreateKnownCredentialsMcpClientOptions',
      'JsonSerializable',
      'McpClientConnection',
      'McpClientData',
      'McpClientStore',
    ],
  },
  './tools': {
    values: [
      'BrowserSessionError',
      'FeedbackSubmissionError',
      'browserSessionInstructions',
      'createBrowserSession',
      'createBrowserSessionTool',
      'submitFeedback',
      'submitFeedbackTool',
    ],
    types: [
      'BrowserSession',
      'BrowserSessionErrorCode',
      'CreateBrowserSessionOptions',
      'CreateBrowserSessionRequest',
      'CreateBrowserSessionTool',
      'FeedbackOrigin',
      'FeedbackReport',
      'SubmitFeedbackOptions',
      'SubmitFeedbackTool',
      'SubmitFeedbackToolOptions',
      'SubmittedFeedback',
    ],
  },
  './server': {
    values: [
      'McpAuthError',
      'McpTokenVerificationError',
      'fetchAuthorizationServerMetadata',
      'generateProtectedResourceMetadata',
      'isClerkAuthInfo',
      'matchResourceUrl',
      'metadataCorsHeaders',
      'requireAdditionalScopes',
      'toClerkAuthInfo',
    ],
    types: ['ClerkAuthInfo', 'ClerkOAuthClient', 'McpAuthFailure', 'McpResourceUrl'],
  },
  './next': {
    values: [
      'McpAuthError',
      'McpTokenVerificationError',
      'authorizationServerMetadataHandler',
      'fetchAuthorizationServerMetadata',
      'generateProtectedResourceMetadata',
      'isClerkAuthInfo',
      'matchResourceUrl',
      'mcpAuth',
      'metadataCorsHandler',
      'metadataCorsHeaders',
      'protectedResourceMetadataHandler',
      'requireAdditionalScopes',
      'toClerkAuthInfo',
      'withMcpAuth',
    ],
    types: [
      'ClerkAuthInfo',
      'ClerkOAuthClient',
      'McpAuthClerkOptions',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpResourceUrl',
      'WithMcpAuthOptions',
    ],
  },
  './next/client': {
    values: ['completeOAuthHandler'],
    types: [],
  },
  './express': {
    values: [
      'McpAuthError',
      'McpTokenVerificationError',
      'authorizationServerMetadataHandler',
      'fetchAuthorizationServerMetadata',
      'generateProtectedResourceMetadata',
      'isClerkAuthInfo',
      'matchResourceUrl',
      'mcpAuth',
      'metadataCorsHeaders',
      'protectedResourceMetadataHandler',
      'requireAdditionalScopes',
      'streamableHttpHandler',
      'toClerkAuthInfo',
    ],
    types: [
      'ClerkAuthInfo',
      'ClerkOAuthClient',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpResourceUrl',
    ],
  },
  './hono': {
    values: [
      'McpAuthError',
      'McpTokenVerificationError',
      'authorizationServerMetadataHandler',
      'fetchAuthorizationServerMetadata',
      'generateProtectedResourceMetadata',
      'isClerkAuthInfo',
      'matchResourceUrl',
      'mcpAuth',
      'metadataCorsHeaders',
      'protectedResourceMetadataHandler',
      'requireAdditionalScopes',
      'streamableHttpHandler',
      'toClerkAuthInfo',
    ],
    types: [
      'ClerkAuthInfo',
      'ClerkOAuthClient',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpResourceUrl',
    ],
  },
  './stores/fs': { values: ['createFsStore'], types: ['FsStoreConfig'] },
  './stores/redis': { values: ['createRedisStore'], types: ['RedisStoreConfig'] },
  './stores/postgres': { values: ['createPostgresStore'], types: ['PostgresStoreConfig'] },
  './stores/sqlite': { values: ['createSqliteStore'], types: ['SqliteStoreConfig'] },
};

const root = dirname(fileURLToPath(import.meta.url));

type ExportTarget = string | { import: string; types: string };

const exportsMap: Record<string, ExportTarget> = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).exports;

// `./dist/next/index.mjs` is built from `next/index.ts`. A target that is not a built module, such as a bare
// directory, has no entry module.
function entrySource(target: ExportTarget) {
  const built = typeof target === 'string' ? target : target.import;
  const match = /^\.\/dist\/(.+)\.mjs$/.exec(built);
  return match ? join(root, `${match[1]}.ts`) : undefined;
}

const entries = Object.entries(exportsMap).map(([subpath, target]) => ({
  subpath,
  source: entrySource(target),
}));

const program = ts.createProgram(
  entries.flatMap(({ source }) => (source ? [source] : [])),
  {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
);
const checker = program.getTypeChecker();

function isTypeOnlyDeclaration(declaration: ts.Declaration) {
  if (ts.isExportSpecifier(declaration)) {
    return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  }
  if (ts.isImportSpecifier(declaration)) {
    return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  }
  if (ts.isImportClause(declaration)) return declaration.isTypeOnly;
  return false;
}

// A name is a value export when it resolves to a runtime binding through no `export type` or `import type` on the
// way. Classes count as values. Everything else is a type export.
function isValueExport(symbol: ts.Symbol): boolean {
  let current = symbol;
  while (current.flags & ts.SymbolFlags.Alias) {
    if (current.declarations?.some(isTypeOnlyDeclaration)) return false;
    current = checker.getImmediateAliasedSymbol(current) ?? current;
    if (current === symbol) break;
  }
  return (current.flags & ts.SymbolFlags.Value) !== 0;
}

function surfaceOf(source: string | undefined): Surface {
  if (!source) return null;
  const file = program.getSourceFile(source);
  if (!file) throw new Error(`${source} is not part of the program`);
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (!moduleSymbol) return { values: [], types: [] };

  const exported = checker.getExportsOfModule(moduleSymbol);
  const sorted = (symbols: ts.Symbol[]) => symbols.map((s) => s.getName()).sort();
  return {
    values: sorted(exported.filter(isValueExport)),
    types: sorted(exported.filter((s) => !isValueExport(s))),
  };
}

describe('export surface', () => {
  test.each(entries)('$subpath exports exactly its pinned names', ({ subpath, source }) => {
    expect(subpath in PINNED, `${subpath} has no pinned export list`).toBe(true);
    expect(surfaceOf(source), `${subpath} export surface`).toEqual(PINNED[subpath]);
  });

  // An adapter user imports from exactly one subpath, so every adapter carries all of the core subpath. Read from the
  // entry modules, not the pins, so the rule holds whatever the pins say.
  test.each(['./next', './express', './hono'])(
    '%s exports every name ./server exports',
    (adapter) => {
      const surfaceAt = (subpath: string) => {
        const target = exportsMap[subpath];
        if (!target) throw new Error(`${subpath} is not in the exports map`);
        const surface = surfaceOf(entrySource(target));
        if (!surface) throw new Error(`${subpath} has no entry module`);
        return surface;
      };
      const core = surfaceAt('./server');
      const surface = surfaceAt(adapter);
      expect(
        core.values.filter((name) => !surface.values.includes(name)),
        'missing values',
      ).toEqual([]);
      expect(
        core.types.filter((name) => !surface.types.includes(name)),
        'missing types',
      ).toEqual([]);
    },
  );

  test('every pinned subpath is in the exports map', () => {
    expect(Object.keys(PINNED).filter((subpath) => !(subpath in exportsMap))).toEqual([]);
  });
});
