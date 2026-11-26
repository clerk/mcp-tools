// The SDK 1.x deprecation, through the published surface: the built declarations of every adapter's
// `streamableHttpHandler` carry `@deprecated`, and serving with it logs one warning per process.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import express from 'express';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { withListening } from './mcp-harness';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEPRECATION =
  "`streamableHttpHandler` is the MCP SDK 1.x path (`@modelcontextprotocol/sdk`): it can't serve protocol revision 2026-07-28 or `server/discover`, so clients fall back to an older revision. Build the server with MCP SDK 2.x (`@modelcontextprotocol/server`) and serve the handler `createMcpHandler` returns with `clerkInstrumentHandler(handler, options)`. `streamableHttpHandler` will be removed in `@clerk/mcp-tools` 2.0.";
const WARNING = `Clerk warning: \`streamableHttpHandler\` is deprecated. ${DEPRECATION}`;

const ADAPTERS = ['hono', 'express'] as const;

const createServer = () => new McpServer({ name: 'test-server', version: '1.0.0' });

const initialize = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  }),
};

// Each adapter's handler on a fresh module registry, the way a new process loads the package
async function serveHono() {
  const { streamableHttpHandler } = await import('../hono');
  const app = new Hono();
  app.all('/mcp', streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport));
  return async () => {
    const res = await app.request('http://localhost/mcp', initialize);
    await res.text();
    return res.status;
  };
}

async function serveExpress() {
  const { streamableHttpHandler } = await import('../express');
  const app = express();
  app.use(express.json());
  app.all('/mcp', streamableHttpHandler(createServer, StreamableHTTPServerTransport));
  return () =>
    withListening(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/mcp`, initialize);
      await res.text();
      return res.status;
    });
}

const SERVE = { hono: serveHono, express: serveExpress };

describe('the streamableHttpHandler deprecation warning', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each(ADAPTERS)('%s warns once across several requests', async (adapter) => {
    const send = await SERVE[adapter]();

    const statuses = [await send(), await send(), await send()];

    expect(statuses).toEqual([200, 200, 200]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(WARNING);
  });

  test('warns once per process, however many handlers the adapters create', async () => {
    const sends = [await serveHono(), await serveHono(), await serveExpress()];

    for (const send of sends) await send();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(WARNING);
  });
});

describe('the published streamableHttpHandler declarations', () => {
  let outDir: string;
  let declarations: Record<string, string>;

  beforeEach(async () => {
    if (declarations) return;
    outDir = mkdtempSync(join(tmpdir(), 'mcp-tools-dts-'));
    // The package's own build config, so the declarations are the ones the package publishes
    await build({
      cwd: root,
      entry: ADAPTERS.map((adapter) => `${adapter}/index.ts`),
      outDir,
      logLevel: 'silent',
    });
    declarations = Object.fromEntries(
      ADAPTERS.map((adapter) => [
        adapter,
        readFileSync(join(outDir, adapter, 'index.d.mts'), 'utf8'),
      ]),
    );
    rmSync(outDir, { recursive: true, force: true });
  }, 60_000);

  function deprecationOf(source: string) {
    const file = ts.createSourceFile('index.d.mts', source, ts.ScriptTarget.ES2022, true);
    const declaration = file.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'streamableHttpHandler',
    );
    if (!declaration) throw new Error('streamableHttpHandler is not declared');
    const tag = ts.getJSDocTags(declaration).find(({ tagName }) => tagName.text === 'deprecated');
    return tag && ts.getTextOfJSDocComment(tag.comment)?.replace(/\s+/g, ' ');
  }

  test.each(ADAPTERS)('%s carries @deprecated with the migration text', (adapter) => {
    expect(deprecationOf(declarations[adapter]!)).toBe(DEPRECATION);
  });
});
