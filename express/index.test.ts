import type express from 'express';
import { describe, test, expect, vi } from 'vitest';

// If the adapter ever eagerly imports the optional @clerk/express peer
// again, this module-level mock makes the import of './index' below throw.
vi.mock('@clerk/express', () => {
  throw new Error('@clerk/express must not be loaded eagerly');
});

import {
  createMcpServer,
  discoverBody,
  discoverHeaders,
  initializeBody,
  mcpHeaders,
  readJsonRpcMessage,
} from '../test-helpers';
import { streamableHttpHandler } from './index';

// Minimal duck-typed req/res pairs — toNodeHandler only touches the
// NodeIncomingMessageLike/NodeServerResponseLike surface, and the body is
// delivered pre-parsed the way express.json() would.
function mockReq(body: string, headers: Record<string, string> = {}, method = 'POST') {
  return {
    method,
    url: '/mcp',
    headers: Object.fromEntries(
      Object.entries({ ...mcpHeaders, host: 'localhost', ...headers }).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    ),
    body: body ? JSON.parse(body) : undefined,
    async *[Symbol.asyncIterator]() {},
  } as unknown as express.Request;
}

function mockRes() {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  const res = {
    writeHead(code: number, resHeaders?: Record<string, string>) {
      statusCode = code;
      headers = resHeaders ?? {};
      return res;
    },
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk));
      return true;
    },
    end(chunk?: string | Uint8Array) {
      if (chunk) chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk));
    },
    on() {
      return res;
    },
  };

  return {
    res: res as unknown as express.Response,
    toResponse: () => new Response(chunks.join(''), { status: statusCode, headers }),
  };
}

describe('streamableHttpHandler', () => {
  test('answers the legacy initialize handshake with an InitializeResult', async () => {
    const handler = streamableHttpHandler(createMcpServer);
    const { res, toResponse } = mockRes();

    await handler(mockReq(initializeBody), res);

    const response = toResponse();
    expect(response.status).toBe(200);
    const message = await readJsonRpcMessage(response);
    expect(message.result.protocolVersion).toBeDefined();
    expect(message.result.serverInfo.name).toBe('test-server');
  });

  test('answers the modern server/discover handshake with a DiscoverResult', async () => {
    const handler = streamableHttpHandler(createMcpServer);
    const { res, toResponse } = mockRes();

    await handler(mockReq(discoverBody, discoverHeaders), res);

    const response = toResponse();
    expect(response.status).toBe(200);
    const message = await readJsonRpcMessage(response);
    expect(message.result.supportedVersions).toContain('2026-07-28');
    expect(message.result.capabilities).toBeDefined();
  });

  test('creates a fresh server per request', async () => {
    const createServer = vi.fn(createMcpServer);
    const handler = streamableHttpHandler(createServer);

    for (const _ of [1, 2]) {
      const { res } = mockRes();
      await handler(mockReq(initializeBody), res);
    }

    expect(createServer).toHaveBeenCalledTimes(2);
  });

  test.each(['GET', 'DELETE'])(
    'answers %s with a 405 JSON-RPC error (legacy session ops are gone)',
    async (method) => {
      const handler = streamableHttpHandler(createMcpServer);
      const { res, toResponse } = mockRes();

      await handler(mockReq('', {}, method), res);

      const response = toResponse();
      expect(response.status).toBe(405);
      expect((await response.json()).error.message).toBe('Method not allowed.');
    },
  );

  test('module loads without the optional @clerk/express peer', () => {
    // The vi.mock at the top of this file throws if @clerk/express is
    // imported eagerly — reaching this assertion proves it wasn't.
    expect(streamableHttpHandler).toBeTypeOf('function');
  });
});
