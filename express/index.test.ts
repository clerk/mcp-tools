import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe, expect, test, vi } from 'vitest';
import { streamableHttpHandler } from './index';

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
  handler: ReturnType<typeof streamableHttpHandler>,
  fn: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.post('/mcp', handler);

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
