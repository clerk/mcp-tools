import type { AuthInfo } from '@modelcontextprotocol/server';
import { describe, test, expect, vi } from 'vitest';

import {
  createMcpServer,
  discoverBody,
  discoverHeaders,
  initializeBody,
  mcpHeaders,
  readJsonRpcMessage,
} from '../test-helpers';
import { streamableHttpHandler } from './index';

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

    const res = await handler(mcpRequest(discoverBody, discoverHeaders));

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
