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
      'completeAuthWithCode',
      'createDynamicallyRegisteredMcpClient',
      'createKnownCredentialsMcpClient',
      'getClientBySessionId',
    ],
    types: [
      'ClientData',
      'CreateDynamicallyRegisteredMcpClientParams',
      'CreateKnownCredentialsMcpClientParams',
      'JsonSerializable',
      'McpClientReturnType',
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
      'corsHeaders',
      'fetchClerkAuthorizationServerMetadata',
      'generateClerkProtectedResourceMetadata',
      'generateProtectedResourceMetadata',
      'isClerkAuthInfo',
      'matchResourceUrl',
      'requireAdditionalScopes',
      'verifyClerkToken',
    ],
    types: ['ClerkAuthInfo', 'ClerkOAuthAuthObject'],
  },
  './next': {
    values: [
      'McpAuthError',
      'McpTokenVerificationError',
      'authServerMetadataHandler',
      'mcpAuth',
      'metadataCorsOptionsRequestHandler',
      'protectedResourceHandler',
      'requireAdditionalScopes',
      'verifyClerkToken',
      'withMcpAuth',
    ],
    types: [
      'ClerkOAuthClient',
      'McpAuthClerkOptions',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpResourceUrl',
      'McpRouteHandler',
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
      'authServerMetadataHandler',
      'mcpAuth',
      'mcpAuthClerk',
      'protectedResourceHandler',
      'streamableHttpHandler',
    ],
    types: [
      'ClerkOAuthClient',
      'McpAuthClerkOptions',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpResourceUrl',
      'McpServerLike',
      'NodeStreamableHttpTransport',
      'StreamableHttpTransportClass',
    ],
  },
  './hono': {
    values: [
      'McpAuthError',
      'McpTokenVerificationError',
      'authServerMetadataHandler',
      'mcpAuth',
      'mcpAuthClerk',
      'protectedResourceHandler',
      'streamableHttpHandler',
    ],
    types: [
      'ClerkOAuthClient',
      'McpAuthClerkOptions',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpResourceUrl',
      'McpServerLike',
      'StreamableHttpTransportClass',
      'WebStandardStreamableHttpTransport',
    ],
  },
  // A bare directory, not a module
  './stores': null,
  './stores/fs': { values: ['createFsStore', 'default'], types: ['FsStoreConfig'] },
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

  test('every pinned subpath is in the exports map', () => {
    expect(Object.keys(PINNED).filter((subpath) => !(subpath in exportsMap))).toEqual([]);
  });
});
