import { toNodeHandler } from '@modelcontextprotocol/node';
import { McpServer, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type express from 'express';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mcpAuth, protectedResourceHandler, streamableHttpHandler } from './index';

vi.mock('@modelcontextprotocol/node', () => ({
  toNodeHandler: vi.fn(() => vi.fn()),
}));

const authInfo: AuthInfo = {
  token: 'valid-token',
  scopes: ['read'],
  clientId: 'client-1',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const legacyInitializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

function createMcpServer() {
  return new McpServer({ name: 'test-server', version: '1.0.0' });
}

function request(overrides: Record<string, unknown> = {}): express.Request {
  return {
    protocol: 'https',
    originalUrl: '/mcp',
    headers: {},
    get: vi.fn((name: string) => (name.toLowerCase() === 'host' ? 'app.example.com' : undefined)),
    ...overrides,
  } as unknown as express.Request;
}

function response(): express.Response {
  const result = {
    status: vi.fn(),
    set: vi.fn(),
    json: vi.fn(),
  };
  result.status.mockReturnValue(result);
  result.set.mockReturnValue(result);
  result.json.mockReturnValue(result);
  return result as unknown as express.Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(toNodeHandler).mockReturnValue(vi.fn());
});

describe('Express adapter', () => {
  test('returns path-aware protected resource metadata', () => {
    const handler = protectedResourceHandler({ authServerUrl: 'https://auth.example.com' });
    const req = request({
      originalUrl: '/.well-known/oauth-protected-resource/mcp?ignored=true',
    });
    const res = response();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: 'https://app.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      }),
    );
  });

  test('returns an SDK bearer challenge for a missing token', async () => {
    const verifier: OAuthTokenVerifier = { verifyAccessToken: vi.fn() };
    const handler = mcpAuth(verifier);
    const req = request();
    const res = response();

    await handler(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.set).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining(
        'resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"',
      ),
    );
  });

  test('adapts parsed Express bodies and keeps the server factory request-scoped', async () => {
    const factory = vi.fn(() => createMcpServer());
    const handler = streamableHttpHandler(factory);
    const nodeHandler = vi.mocked(toNodeHandler).mock.results[0]!.value;
    const req = request({ body: legacyInitializeBody });
    const res = response();

    await handler(req, res, vi.fn());

    expect(nodeHandler).toHaveBeenCalledWith(req, res, legacyInitializeBody);

    const mcpHandler = vi.mocked(toNodeHandler).mock.calls[0]![0];
    const createRequest = () =>
      new Request('https://app.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(legacyInitializeBody),
      });
    await mcpHandler.fetch(createRequest(), { authInfo });
    await mcpHandler.fetch(createRequest(), { authInfo });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ era: 'legacy', authInfo }),
    );
    expect(factory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ era: 'legacy', authInfo }),
    );
  });
});
