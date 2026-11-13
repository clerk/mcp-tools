import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// The exact public surface of every module subpath in the `exports` map. A change to any entry point's exports must
// change this list in the same commit, so the surface only ever changes on purpose.
type Surface = { values: string[]; types: string[] };

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
      'CREATE_BROWSER_SESSION_TOOL_NAME',
      'FeedbackSubmissionError',
      'SUBMIT_FEEDBACK_TOOL_NAME',
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
      'CreateBrowserSessionToolOptions',
      'FeedbackImpact',
      'FeedbackKind',
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
    types: [
      'ClerkAuthInfo',
      'ClerkOAuthAuth',
      'ClerkOAuthClient',
      'McpAuthFailure',
      'McpPublicMethod',
      'McpResourceUrl',
      'PublicAccess',
    ],
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
      'metadataCorsHandler',
      'metadataCorsHeaders',
      'protectedResourceMetadataHandler',
      'requireAdditionalScopes',
      'toClerkAuthInfo',
      'withMcpAuth',
    ],
    types: [
      'ClerkAuthInfo',
      'ClerkOAuthAuth',
      'ClerkOAuthClient',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpPublicMethod',
      'McpResourceUrl',
      'ProtectedResourceMetadataOptions',
      'PublicAccess',
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
      'ClerkOAuthAuth',
      'ClerkOAuthClient',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpPublicMethod',
      'McpResourceUrl',
      'ProtectedResourceMetadataOptions',
      'PublicAccess',
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
      'ClerkOAuthAuth',
      'ClerkOAuthClient',
      'McpAuthFailure',
      'McpAuthOptions',
      'McpPublicMethod',
      'McpResourceUrl',
      'ProtectedResourceMetadataOptions',
      'PublicAccess',
    ],
  },
  './stores/fs': { values: ['createFsStore'], types: ['FsStoreConfig'] },
  './stores/redis': { values: ['createRedisStore'], types: ['RedisStoreConfig'] },
  './stores/postgres': { values: ['createPostgresStore'], types: ['PostgresStoreConfig'] },
  './stores/sqlite': { values: ['createSqliteStore'], types: ['SqliteStoreConfig'] },
};

const root = dirname(fileURLToPath(import.meta.url));

type ExportTarget = string | Record<string, string>;

const packageJson: { name: string; main?: unknown; exports: Record<string, ExportTarget> } =
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const exportsMap = packageJson.exports;

// The one subpath that is not a module: it exposes the manifest so tools can read the package version.
const MANIFEST_SUBPATH = './package.json';

// Subpaths earlier releases exported that must stay gone.
const REMOVED_SUBPATHS = ['./feedback', './create-browser-session', './stores', '.'];

// `./dist/next/index.mjs` is built from `next/index.ts`. Every module subpath must point at a built module.
function entrySource(subpath: string, target: ExportTarget) {
  const built = typeof target === 'string' ? target : target.import;
  const match = built ? /^\.\/dist\/(.+)\.mjs$/.exec(built) : null;
  if (!match) throw new Error(`${subpath} does not point at a built module`);
  return join(root, `${match[1]}.ts`);
}

const entries = Object.entries(exportsMap)
  .filter(([subpath]) => subpath !== MANIFEST_SUBPATH)
  .map(([subpath, target]) => ({ subpath, source: entrySource(subpath, target) }));

const program = ts.createProgram(
  entries.map(({ source }) => source),
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

function surfaceOf(source: string): Surface {
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
        return surfaceOf(entrySource(subpath, target));
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

  test.each(REMOVED_SUBPATHS)('%s is not exported', (subpath) => {
    expect(exportsMap).not.toHaveProperty([subpath]);
  });

  // TypeScript picks the first condition that matches, so `types` must come before `import` for every module
  // resolution mode to find the declarations.
  test.each(entries.map(({ subpath }) => subpath))(
    '%s lists the types condition first',
    (subpath) => {
      expect(Object.keys(exportsMap[subpath] ?? {})).toEqual(['types', 'import', 'default']);
    },
  );

  // `default` lets `require(esm)` (Node 22 and later) and CJS-condition resolvers load the same ESM build.
  test.each(entries.map(({ subpath }) => subpath))(
    '%s points default at the import build',
    (subpath) => {
      const target = exportsMap[subpath];
      if (typeof target !== 'object') throw new Error(`${subpath} has no conditions`);
      expect(target.default).toBe(target.import);
    },
  );

  test('has no main field, since the package has no root entry point', () => {
    expect(packageJson).not.toHaveProperty('main');
  });

  test('@clerk/mcp-tools/package.json resolves to the manifest', () => {
    const resolved = createRequire(import.meta.url).resolve(`${packageJson.name}/package.json`);
    expect(resolved).toBe(join(root, 'package.json'));
  });
});
