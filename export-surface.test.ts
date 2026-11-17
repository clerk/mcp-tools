import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// The exact public surface of every module subpath in the `exports` map. A change to any entry point's exports must
// change this list in the same commit, so the surface only ever changes on purpose.
type Surface = { values: string[]; types: string[] };

// An adapter user imports from exactly one subpath, so every adapter pin carries all of `./server`.
const SERVER: Surface = {
  values: [
    'McpAuthError',
    'McpTokenVerificationError',
    'fetchAuthorizationServerMetadata',
    'generateProtectedResourceMetadata',
    'generateServerCard',
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
    'ServerCard',
    'ServerCardIcon',
    'ServerCardOptions',
    'ServerCardRepository',
  ],
};

const withServer = (values: string[], types: string[]): Surface => ({
  values: [...SERVER.values, ...values].sort(),
  types: [...SERVER.types, ...types].sort(),
});

// The Express and Hono adapters export the same names on top of `./server`
const ADAPTER: Surface = {
  values: [
    'authorizationServerMetadataHandler',
    'mcpAuth',
    'protectedResourceMetadataHandler',
    'streamableHttpHandler',
  ],
  types: ['McpAuthOptions', 'ProtectedResourceMetadataOptions'],
};

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
      'ERROR_CODE_META_KEY',
      'FEEDBACK_IMPACTS',
      'FEEDBACK_KINDS',
      'FeedbackSubmissionError',
      'SUBMIT_FEEDBACK_INSTRUCTIONS',
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
  './server': SERVER,
  './next': withServer(
    [
      'authorizationServerMetadataHandler',
      'metadataCorsHandler',
      'protectedResourceMetadataHandler',
      'withClerkMcpAuth',
    ],
    ['McpAuthOptions', 'ProtectedResourceMetadataOptions'],
  ),
  './next/client': {
    values: ['completeOAuthHandler'],
    types: [],
  },
  './express': withServer(ADAPTER.values, ADAPTER.types),
  // The discovery handlers reach Express and Next.js in CLRK-220 and CLRK-221
  './hono': withServer(
    [...ADAPTER.values, 'serverCardHandler'],
    [...ADAPTER.types, 'ServerCardHandlerOptions'],
  ),
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

  test('every pinned subpath is in the exports map', () => {
    expect(Object.keys(PINNED).filter((subpath) => !(subpath in exportsMap))).toEqual([]);
  });

  test.each(REMOVED_SUBPATHS)('%s is not exported', (subpath) => {
    expect(exportsMap).not.toHaveProperty([subpath]);
  });

  // TypeScript picks the first condition that matches, so `types` must come before `import` for every module
  // resolution mode to find the declarations. `default` lets `require(esm)` and CJS-condition resolvers load the
  // same ESM build.
  test.each(entries.map(({ subpath }) => subpath))(
    '%s lists the types condition first and points default at the import build',
    (subpath) => {
      const target = exportsMap[subpath] as Record<string, string>;
      expect(Object.keys(target)).toEqual(['types', 'import', 'default']);
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
