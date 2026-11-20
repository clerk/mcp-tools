// End to end: a tool list that differs per caller, written by the server author as the README describes it, on each
// adapter and on MCP SDK 1.x and 2.x. The server factory closes over the request's auth info and registers a tool only
// for the callers who may have it.
import { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport as WebTransportV1 } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  McpServer as McpServerV2,
  WebStandardStreamableHTTPServerTransport as WebTransportV2,
} from '@modelcontextprotocol/server';
import express from 'express';
import { Hono } from 'hono';
import { createMcpHandler } from 'mcp-handler';
import { describe, expect, test } from 'vitest';

import * as expressAdapter from '../express';
import * as honoAdapter from '../hono';
import type { AuthInfo } from '../mcp-types';
import * as nextAdapter from '../next';
import { expiresAt, withListening } from './mcp-harness';

const ORIGIN = 'https://mcp.example.com';

const TOKENS: Record<string, string> = { token_member: 'member', token_admin: 'admin' };

function verifyToken(token: string): AuthInfo | undefined {
  const role = TOKENS[token];
  return role
    ? { token, clientId: 'client_1', scopes: [], expiresAt, extra: { userId: 'user_1', role } }
    : undefined;
}

const authOptions = (resourceUrl: string) => ({
  verifyToken,
  resourceUrl,
  publicAccess: { methods: true, tools: ['search_docs'] },
});

const result = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const isAdmin = (authInfo: AuthInfo | undefined) => authInfo?.extra?.role === 'admin';

// What the README recipe registers: an admin tool only for an admin, so no other caller can list or call it
type Registrar = {
  registerTool(
    name: string,
    config: { description: string },
    callback: () => Promise<ReturnType<typeof result>>,
  ): unknown;
};

function registerTools(server: Registrar, { admin }: { admin: boolean }) {
  server.registerTool('search_docs', { description: 'Searches the public docs' }, async () =>
    result('results'),
  );
  server.registerTool('list_projects', { description: 'Lists your projects' }, async () =>
    result('projects'),
  );
  if (admin) {
    server.registerTool('delete_project', { description: 'Deletes a project' }, async () =>
      result('deleted'),
    );
  }
}

type Send = (message: Record<string, unknown>, token?: string) => Promise<Response>;

const headers = (token: string | undefined) => ({
  ...(token && { authorization: `Bearer ${token}` }),
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-03-26',
});

// The JSON-RPC message of a response, which the transports send as JSON or as one server-sent event
async function messageOf(response: Response) {
  const text = await response.text();
  const data = text.startsWith('{') ? text : text.match(/^data: (.+)$/m)?.[1];
  return JSON.parse(data!) as {
    result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
    error?: { code: number; message: string };
  };
}

async function listedTools(send: Send, token?: string) {
  const response = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token);
  expect(response.status).toBe(200);
  return (await messageOf(response)).result!.tools!.map((tool) => tool.name);
}

const callDeleteProject = (send: Send, token?: string) =>
  send(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'delete_project', arguments: {} },
    },
    token,
  );

// The Next.js recipe: one handler for each set of tools, built once and chosen per request
function nextRoute(options: { maxSubscriptions?: number } = {}) {
  const handlers = {
    admin: createMcpHandler((server) => registerTools(server, { admin: true }), options),
    default: createMcpHandler((server) => registerTools(server, { admin: false }), options),
  };
  return nextAdapter.withClerkMcpAuth(
    (req) =>
      handlers[isAdmin((req as Request & { auth?: AuthInfo }).auth) ? 'admin' : 'default'](req),
    authOptions(`${ORIGIN}/mcp`),
  );
}

const servers: Record<string, (run: (send: Send) => Promise<void>) => Promise<void>> = {
  'express on MCP SDK 1.x': async (run) => {
    const app = express();
    app.use(express.json());
    await withListening(app, async (base) => {
      app.all('/mcp', expressAdapter.mcpAuth(authOptions(`${base}/mcp`)), (req, res) =>
        expressAdapter.streamableHttpHandler(() => {
          const server = new McpServerV1({ name: 'projects', version: '0.0.0' });
          registerTools(server, {
            admin: isAdmin((req as express.Request & { auth?: AuthInfo }).auth),
          });
          return server;
        }, StreamableHTTPServerTransport)(req, res),
      );
      await run((message, token) =>
        fetch(`${base}/mcp`, {
          method: 'POST',
          headers: headers(token),
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(5000),
        }),
      );
    });
  },
  'hono on MCP SDK 1.x': async (run) => {
    const app = new Hono();
    app.all('/mcp', honoAdapter.mcpAuth(authOptions(`${ORIGIN}/mcp`)), (c) =>
      honoAdapter.streamableHttpHandler(() => {
        const server = new McpServerV1({ name: 'projects', version: '0.0.0' });
        registerTools(server, { admin: isAdmin(c.get('mcpAuth')) });
        return server;
      }, WebTransportV1)(c),
    );
    await run(async (message, token) =>
      app.request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(message),
      }),
    );
  },
  'hono on MCP SDK 2.x': async (run) => {
    const app = new Hono();
    app.all('/mcp', honoAdapter.mcpAuth(authOptions(`${ORIGIN}/mcp`)), (c) =>
      honoAdapter.streamableHttpHandler(() => {
        const server = new McpServerV2({ name: 'projects', version: '0.0.0' });
        registerTools(server, { admin: isAdmin(c.get('mcpAuth')) });
        return server;
      }, WebTransportV2)(c),
    );
    await run(async (message, token) =>
      app.request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(message),
      }),
    );
  },
  'next with mcp-handler on MCP SDK 2.x': async (run) => {
    const route = nextRoute();
    await run(async (message, token) =>
      route(
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: headers(token),
          body: JSON.stringify(message),
        }),
      ),
    );
  },
};

describe.each(Object.entries(servers))('a per-caller tool list: %s', (name, withServer) => {
  test('lists a tool only to the callers the server registered it for', async () => {
    await withServer(async (send) => {
      expect(await listedTools(send)).toEqual(['search_docs', 'list_projects']);
      expect(await listedTools(send, 'token_member')).toEqual(['search_docs', 'list_projects']);
      expect(await listedTools(send, 'token_admin')).toEqual([
        'search_docs',
        'list_projects',
        'delete_project',
      ]);
    });
  });

  test('runs the hidden tool only for those callers', async () => {
    await withServer(async (send) => {
      // Not in `publicAccess.tools`, so a request without a token never reaches the server
      expect((await callDeleteProject(send)).status).toBe(401);

      // For any other caller the tool does not exist, so there is no step-up challenge either
      const refused = await callDeleteProject(send, 'token_member');
      expect(refused.status).toBe(200);
      expect(refused.headers.get('www-authenticate')).toBeNull();
      const message = await messageOf(refused);
      expect(message.error?.message ?? message.result?.content?.[0]?.text).toContain(
        'Tool delete_project not found',
      );
      // MCP SDK 2.x answers with a JSON-RPC error, and 1.x with an error result
      if (name.endsWith('2.x')) expect(message.error?.code).toBe(-32602);
      else expect(message.result?.isError).toBe(true);

      const allowed = await callDeleteProject(send, 'token_admin');
      expect(allowed.status).toBe(200);
      expect((await messageOf(allowed)).result?.content?.[0]?.text).toBe('deleted');
    });
  });
});

// MCP SDK 2.x counts the subscriptions/listen streams a handler holds open against `maxSubscriptions`, so a handler
// built for each request would never reach the limit
describe('a per-caller tool list: next with mcp-handler, on protocol revision 2026-07-28', () => {
  test('keeps the limit on listen streams from clients without a token', async () => {
    const route = nextRoute({ maxSubscriptions: 1 });
    const abort = new AbortController();
    const listen = () =>
      route(
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'subscriptions/listen',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'subscriptions/listen',
            params: {
              notifications: { toolsListChanged: true },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'client', version: '0.0.0' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
          signal: abort.signal,
        }),
      );

    const open = await listen();
    expect(open.status).toBe(200);
    expect(open.headers.get('content-type')).toBe('text/event-stream');

    const refused = await listen();
    expect((await messageOf(refused)).error?.message).toBe('Subscription limit reached');
    abort.abort();
    await open.body?.cancel();
  });
});
