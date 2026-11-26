// Conformance on the newest protocol revision: a client independent of the MCP SDK, hand-written JSON-RPC over raw
// HTTP, sends the 2026-07-28 `server/discover` to each adapter's auth in front of each MCP SDK's handler.
import { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import express from 'express';
import { createMcpHandler as createNextMcpHandler } from 'mcp-handler';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import * as expressAdapter from '../express';
import * as fetchAdapter from '../fetch';
import * as honoAdapter from '../hono';
import type { AuthInfo } from '../mcp-types';
import * as nextAdapter from '../next';
import { expiresAt, withListening } from './mcp-harness';

const ORIGIN = 'https://mcp.example.com';
const MCP_URL = `${ORIGIN}/mcp`;
const TOKEN = 'token_1';

function verifyToken(token: string): AuthInfo | undefined {
  if (token !== TOKEN) return undefined;
  return {
    token,
    clientId: 'client_1',
    scopes: ['profile'],
    expiresAt,
    extra: { userId: 'user_1' },
  };
}

const authOptions = { verifyToken, resourceUrl: MCP_URL };

// The execution context a Worker's `fetch` is called with
const workerCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

function createServerV2() {
  const server = new McpServer({ name: 'conformance', version: '0.0.0' });
  server.registerTool('ping_tool', { description: 'Answers' }, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  return server;
}

function createServerV1() {
  const server = new McpServerV1({ name: 'conformance', version: '0.0.0' });
  server.registerTool('ping_tool', { description: 'Answers' }, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  return server;
}

/** An Express app, served on a real port, or a fetch handler, called in process. */
type App = express.Express | ((request: Request) => Response | Promise<Response>);

const apps: Record<string, { sdk: 1 | 2; mount: () => App }> = {
  'hono clerkInstrumentHandler, MCP SDK 2.x createMcpHandler': {
    sdk: 2,
    mount: () => {
      const app = new Hono();
      app.all(
        '/mcp',
        honoAdapter.clerkInstrumentHandler(createMcpHandler(createServerV2), authOptions),
      );
      return app.fetch;
    },
  },
  'express clerkInstrumentHandler, MCP SDK 2.x createMcpHandler': {
    sdk: 2,
    mount: () => {
      const app = express();
      app.use(express.json());
      app.all(
        '/mcp',
        expressAdapter.clerkInstrumentHandler(createMcpHandler(createServerV2), authOptions),
      );
      return app;
    },
  },
  'next clerkInstrumentHandler, MCP SDK 2.x createMcpHandler': {
    sdk: 2,
    mount: () => nextAdapter.clerkInstrumentHandler(createMcpHandler(createServerV2), authOptions),
  },
  'next clerkInstrumentHandler, mcp-handler createMcpHandler': {
    sdk: 2,
    mount: () =>
      nextAdapter.clerkInstrumentHandler(
        createNextMcpHandler((server) => {
          server.registerTool('ping_tool', { description: 'Answers' }, async () => ({
            content: [{ type: 'text' as const, text: 'pong' }],
          }));
        }),
        authOptions,
      ),
  },
  'fetch clerkInstrumentHandler, MCP SDK 2.x createMcpHandler': {
    sdk: 2,
    mount: () => {
      const authedHandler = fetchAdapter.clerkInstrumentHandler(
        createMcpHandler(createServerV2),
        authOptions,
      );
      return (request: Request) => authedHandler(request, {}, workerCtx);
    },
  },
  'fetch createClerkMcpWorker': {
    sdk: 2,
    mount: () => {
      const worker = fetchAdapter.createClerkMcpWorker({ ...authOptions, server: createServerV2 });
      return (request: Request) => worker.fetch(request, {}, workerCtx);
    },
  },
  'hono, MCP SDK 1.x streamableHttpHandler': {
    sdk: 1,
    mount: () => {
      const app = new Hono();
      app.all(
        '/mcp',
        honoAdapter.mcpAuth(authOptions),
        honoAdapter.streamableHttpHandler(createServerV1, WebStandardStreamableHTTPServerTransport),
      );
      return app.fetch;
    },
  },
  'express, MCP SDK 1.x streamableHttpHandler': {
    sdk: 1,
    mount: () => {
      const app = express();
      app.use(express.json());
      app.all(
        '/mcp',
        expressAdapter.mcpAuth(authOptions),
        expressAdapter.streamableHttpHandler(createServerV1, StreamableHTTPServerTransport),
      );
      return app;
    },
  },
};

// A POST of one JSON-RPC request as a client on `protocolVersion` sends it. From 2026-07-28 every request carries the
// `_meta` envelope, and before it, `initialize` carries the same facts in its params.
function rpcInit(token: string | undefined, protocolVersion: string, method: string): RequestInit {
  const clientInfo = { name: 'conformance-client', version: '0.0.0' };
  const params =
    method === 'initialize'
      ? { protocolVersion, clientInfo, capabilities: {} }
      : {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': protocolVersion,
            'io.modelcontextprotocol/clientInfo': clientInfo,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        };
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
      'mcp-method': method,
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  };
}

type Answer = { status: number; contentType: string | null; message: unknown };

// The one JSON-RPC message in a response, sent as JSON or as the only event of a stream
async function read(res: Response): Promise<Answer> {
  const text = await res.text();
  const contentType = res.headers.get('content-type');
  const data = contentType?.startsWith('text/event-stream')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length)
    : text;
  return { status: res.status, contentType, message: data ? JSON.parse(data) : null };
}

async function send(app: App, init: RequestInit): Promise<Answer> {
  if (!('listen' in app)) return read(await app(new Request(MCP_URL, init)));
  return withListening(app, async (local) =>
    read(await fetch(`${local}/mcp`, { ...init, signal: AbortSignal.timeout(5000) })),
  );
}

// Both a client that has not signed in yet, which `discoverable` lets through by default, and one with a token
const callers = [
  { who: 'without a token', token: undefined },
  { who: 'with a token', token: TOKEN },
];
const casesOn = (sdk: 1 | 2) =>
  Object.entries(apps)
    .filter(([, app]) => app.sdk === sdk)
    .flatMap(([name, { mount }]) => callers.map((caller) => ({ name, mount, ...caller })));

describe('server/discover at protocol revision 2026-07-28 on MCP SDK 2.x', () => {
  test.each(casesOn(2))('$name answers it $who', async ({ mount, token }) => {
    const answer = await send(mount(), rpcInit(token, '2026-07-28', 'server/discover'));

    expect(answer.status).toBeLessThan(400);
    expect(answer.message).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { supportedVersions: expect.arrayContaining(['2026-07-28']) },
    });
  });
});

// SDK 1.x serves only the revisions before 2026-07-28. It answers with the unsupported-version error that names the
// revisions it serves, and a client retries on one of them.
describe('server/discover at protocol revision 2026-07-28 on MCP SDK 1.x', () => {
  test.each(casesOn(1))(
    '$name answers it $who with the fallback a client retries on',
    async ({ mount, token }) => {
      const app = mount();
      const answer = await send(app, rpcInit(token, '2026-07-28', 'server/discover'));

      expect(answer).toEqual({
        status: 400,
        contentType: 'application/json',
        message: {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: expect.stringMatching(
              /^Bad Request: Unsupported protocol version: 2026-07-28 \(supported versions: .*\b2025-11-25\b/,
            ),
          },
        },
      });

      // The retry, on the newest revision the error names
      const retry = await send(app, rpcInit(token, '2025-11-25', 'initialize'));
      expect(retry.status).toBe(200);
      expect(retry.message).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-11-25', serverInfo: { name: 'conformance' } },
      });
    },
  );
});
