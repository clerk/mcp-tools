import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe, expect, test, vi } from 'vitest';
import { mcpAuth, streamableHttpHandler } from './index';

const mcpHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
});

function createMcpServer() {
  return new McpServer({ name: 'test-server', version: '1.0.0' });
}

async function withApp(
  handlers: express.RequestHandler | (express.RequestHandler | express.ErrorRequestHandler)[],
  fn: (baseUrl: string) => Promise<void>,
  { json = true } = {},
) {
  const app = express();
  if (json) app.use(express.json());
  app.post('/mcp', handlers);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postInitialize(baseUrl: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: mcpHeaders,
    body: initializeBody,
  });
}

describe('streamableHttpHandler', () => {
  test('handles an MCP initialize request and returns 200', async () => {
    await withApp(streamableHttpHandler(createMcpServer), async (baseUrl) => {
      const res = await postInitialize(baseUrl);
      expect(res.status).toBe(200);
      await res.text();
    });
  });

  test('handles sequential requests', async () => {
    const createServer = vi.fn(createMcpServer);
    await withApp(streamableHttpHandler(createServer), async (baseUrl) => {
      const res1 = await postInitialize(baseUrl);
      await res1.text();
      const res2 = await postInitialize(baseUrl);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(createServer).toHaveBeenCalledTimes(2);
      await res2.text();
    });
  });

  test('handles concurrent requests', async () => {
    await withApp(streamableHttpHandler(createMcpServer), async (baseUrl) => {
      const [res1, res2] = await Promise.all([postInitialize(baseUrl), postInitialize(baseUrl)]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      await res1.text();
      await res2.text();
    });
  });

  test('handles sequential requests with a shared server instance', async () => {
    await withApp(streamableHttpHandler(createMcpServer()), async (baseUrl) => {
      const res1 = await postInitialize(baseUrl);
      await res1.text();
      // let the transport's close-on-response-end release the shared server
      await vi.waitFor(async () => {
        const res2 = await postInitialize(baseUrl);
        expect(res2.status).toBe(200);
        await res2.text();
      });
    });
  });
});

describe('mcpAuth with toolScopes', () => {
  test('rejects a scope that is not a scope token when it is created', async () => {
    await expect(mcpAuth(async () => undefined, { toolScopes: { t: ['a b'] } })).rejects.toThrow(
      /^Clerk error: mcpAuth toolScopes/,
    );
  });

  const authInfo = { token: 'tok', scopes: ['profile'], clientId: 'c1' };
  const toolScopes = { create_browser_session: ['profile', 'user:org:read'] };

  async function authHandlers() {
    return [
      await mcpAuth(async () => authInfo, { toolScopes }),
      (req: express.Request, res: express.Response) => {
        res.json({ body: req.body });
      },
    ];
  }

  function callTool(baseUrl: string, name: string) {
    return fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, Authorization: 'Bearer tok' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }),
    });
  }

  test('returns a 403 step-up challenge for a tool that needs a scope the token lacks', async () => {
    await withApp(await authHandlers(), async (baseUrl) => {
      const res = await callTool(baseUrl, 'create_browser_session');
      expect(res.status).toBe(403);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        `Bearer error="insufficient_scope", scope="profile user:org:read", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
      );
      expect(await res.json()).toEqual({ error: 'Forbidden' });
    });
  });

  test('lets other calls through', async () => {
    await withApp(await authHandlers(), async (baseUrl) => {
      const res = await callTool(baseUrl, 'whoami');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ body: { params: { name: 'whoami' } } });
    });
  });

  test('fails loudly when express.json() is not registered', async () => {
    const errors: unknown[] = [];
    const onError: express.ErrorRequestHandler = (error, _req, res, _next) => {
      errors.push(error);
      res.status(500).end();
    };
    await withApp(
      [...(await authHandlers()), onError],
      async (baseUrl) => {
        const res = await callTool(baseUrl, 'create_browser_session');
        expect(res.status).toBe(500);
      },
      { json: false },
    );
    expect(errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/^Clerk error: .*express\.json\(\)/),
      }),
    ]);
  });

  // express.json() skips these, but the transport reads any Content-Type that contains application/json.
  test.each(['application/jsonx', 'text/plain; application/json'])(
    'refuses Content-Type %j with a 415 before the tool runs',
    async (contentType) => {
      const toolCallback = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'ran' }],
      }));
      const createServer = () => {
        const server = createMcpServer();
        server.registerTool('create_browser_session', {}, toolCallback);
        return server;
      };
      await withApp(
        [await mcpAuth(async () => authInfo, { toolScopes }), streamableHttpHandler(createServer)],
        async (baseUrl) => {
          const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { ...mcpHeaders, 'Content-Type': contentType, Authorization: 'Bearer tok' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'create_browser_session', arguments: {} },
            }),
          });
          expect(res.status).toBe(415);
          expect(await res.json()).toEqual({ error: 'Unsupported Media Type' });
        },
      );
      expect(toolCallback).not.toHaveBeenCalled();
    },
  );
});
