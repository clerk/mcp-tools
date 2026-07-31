import { McpServer } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { describe, test, expect, vi } from 'vitest';

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
const discoverBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'server/discover',
  params: {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
});

function createMcpServer() {
  return new McpServer({ name: 'test-server', version: '1.0.0' });
}

function mcpRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { ...mcpHeaders, ...headers },
    body,
  });
}

describe('streamableHttpHandler', () => {
  test('answers the legacy initialize handshake with an InitializeResult', async () => {
    const handler = streamableHttpHandler(createMcpServer);

    const res = await handler(mcpRequest(initializeBody));

    expect(res.status).toBe(200);
    const message = await readJsonRpcMessage(res);
    expect(message.result.protocolVersion).toBeDefined();
    expect(message.result.serverInfo.name).toBe('test-server');
  });

  test('answers the modern server/discover handshake with a DiscoverResult', async () => {
    const handler = streamableHttpHandler(createMcpServer);

    const res = await handler(
      mcpRequest(discoverBody, {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
      }),
    );

    expect(res.status).toBe(200);
    const message = await readJsonRpcMessage(res);
    expect(message.result.supportedVersions).toContain('2026-07-28');
    expect(message.result.capabilities).toBeDefined();
  });

  test('creates a fresh server per request', async () => {
    const createServer = vi.fn(createMcpServer);
    const handler = streamableHttpHandler(createServer);

    await handler(mcpRequest(initializeBody));
    await handler(mcpRequest(initializeBody));

    expect(createServer).toHaveBeenCalledTimes(2);
  });

  test('returns 401 with WWW-Authenticate when verifyToken is set and Authorization is missing', async () => {
    const verifyToken = vi.fn();
    const handler = streamableHttpHandler(createMcpServer, { verifyToken });

    const res = await handler(mcpRequest(initializeBody));

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata=http://localhost/.well-known/oauth-protected-resource/mcp',
    );
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('returns 401 when verifyToken rejects the token', async () => {
    const handler = streamableHttpHandler(createMcpServer, {
      verifyToken: async () => undefined,
    });

    const res = await handler(mcpRequest(initializeBody, { Authorization: 'Bearer bad-token' }));

    expect(res.status).toBe(401);
  });

  test('serves the request when verifyToken accepts the token', async () => {
    const authInfo: AuthInfo = {
      token: 'valid',
      scopes: ['read'],
      clientId: 'client-1',
      extra: { userId: 'user-1' },
    };
    const verifyToken = vi.fn().mockResolvedValue(authInfo);
    const handler = streamableHttpHandler(createMcpServer, { verifyToken });

    const res = await handler(mcpRequest(initializeBody, { Authorization: 'Bearer valid' }));

    expect(res.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith('valid', expect.any(Request));
    await res.text();
  });

  test('returns 401 and does not verify when Authorization scheme is not Bearer', async () => {
    const verifyToken = vi.fn();
    const handler = streamableHttpHandler(createMcpServer, { verifyToken });

    const res = await handler(mcpRequest(initializeBody, { Authorization: 'Basic valid' }));

    expect(res.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

// The legacy leg answers over SSE while the modern leg answers with a plain
// JSON body — normalize both to the contained JSON-RPC message.
async function readJsonRpcMessage(res: Response) {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();

  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) throw new Error(`No data line in SSE response: ${text}`);
    return JSON.parse(dataLine.slice('data: '.length));
  }

  return JSON.parse(text);
}
