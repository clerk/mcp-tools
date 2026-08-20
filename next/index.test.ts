import type { AuthInfo } from '@modelcontextprotocol/server';
import type { NextRequest } from 'next/server';
import { describe, test, expect, vi } from 'vitest';

import type { JsonSerializable, McpClientStore } from '../client';
import {
  createMcpServer,
  discoverBody,
  discoverHeaders,
  initializeBody,
  mcpHeaders,
  readJsonRpcMessage,
} from '../test-helpers';
import { completeOAuthHandler, streamableHttpHandler } from './index';

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

  test.each(['GET', 'DELETE'])(
    'answers %s with a 405 JSON-RPC error (legacy session ops are gone)',
    async (method) => {
      const handler = streamableHttpHandler(createMcpServer);

      const res = await handler(new Request('http://localhost/mcp', { method }));

      expect(res.status).toBe(405);
      expect((await res.json()).error.message).toBe('Method not allowed.');
    },
  );

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

  test('rejects a cross-origin browser request with 403 before token verification', async () => {
    const verifyToken = vi.fn();
    const handler = streamableHttpHandler(createMcpServer, { verifyToken });

    const res = await handler(mcpRequest(initializeBody, { Origin: 'https://evil.example' }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain('Invalid Origin');
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('allows a same-origin request by default', async () => {
    const handler = streamableHttpHandler(createMcpServer);

    const res = await handler(mcpRequest(initializeBody, { Origin: 'http://localhost' }));

    expect(res.status).toBe(200);
    await res.text();
  });

  test('allows an allowlisted cross-origin request', async () => {
    const handler = streamableHttpHandler(createMcpServer, {
      allowedOrigins: ['app.example.com'],
    });

    const res = await handler(mcpRequest(initializeBody, { Origin: 'https://app.example.com' }));

    expect(res.status).toBe(200);
    await res.text();
  });
});

describe('completeOAuthHandler error responses', () => {
  const AS_URL = 'https://as.example.com';

  function memoryStore(): McpClientStore {
    const data = new Map<string, JsonSerializable>();
    return {
      read: async (key) => data.get(key) ?? null,
      write: async (key, value) => {
        data.set(key, value);
      },
    };
  }

  // seeds the store with the state → session mapping and discovery state a
  // real flow would have persisted before redirecting
  async function seededStore(state: string) {
    const store = memoryStore();
    await store.write(`state_${state}`, 'session-1');
    await store.write('session_session-1', {
      oauthRedirectUrl: 'https://app.example.com/callback',
      mcpEndpoint: 'https://rs.example.com/mcp',
      mcpClientName: 'test-client',
      mcpClientVersion: '1.0.0',
      discoveryState: {
        authorizationServerUrl: AS_URL,
        authorizationServerMetadata: {
          issuer: AS_URL,
          authorization_response_iss_parameter_supported: true,
        },
      },
    });
    return store;
  }

  function callbackRequest(params: Record<string, string>) {
    const url = new URL('https://app.example.com/callback');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return { nextUrl: url } as unknown as NextRequest;
  }

  test('surfaces an AS error response after its iss validates', async () => {
    const callback = vi.fn();
    const store = await seededStore('state-1');
    const handler = completeOAuthHandler({ store, callback });

    const res = (await handler(
      callbackRequest({
        state: 'state-1',
        error: 'access_denied',
        error_description: 'The user denied the request',
        iss: AS_URL,
      }),
    )) as Response;

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('access_denied');
    expect(body.error_description).toBe('The user denied the request');
    expect(callback).not.toHaveBeenCalled();
  });

  test('refuses an error response whose iss does not match the recorded issuer', async () => {
    const callback = vi.fn();
    const store = await seededStore('state-1');
    const handler = completeOAuthHandler({ store, callback });

    const res = (await handler(
      callbackRequest({
        state: 'state-1',
        error: 'access_denied',
        error_description: 'attacker-controlled text',
        iss: 'https://attacker.example',
      }),
    )) as Response;

    expect(res.status).toBe(400);
    // a mix-up indication: nothing from the callback may be echoed
    const text = await res.text();
    expect(text).not.toContain('access_denied');
    expect(text).not.toContain('attacker-controlled text');
    expect(text).not.toContain('attacker.example');
    expect(callback).not.toHaveBeenCalled();
  });

  test('refuses an error response omitting iss when the AS advertises iss support', async () => {
    const callback = vi.fn();
    const store = await seededStore('state-1');
    const handler = completeOAuthHandler({ store, callback });

    const res = (await handler(
      callbackRequest({ state: 'state-1', error: 'access_denied' }),
    )) as Response;

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('access_denied');
    expect(callback).not.toHaveBeenCalled();
  });

  test('returns 400 when state is missing from an error response', async () => {
    const callback = vi.fn();
    const handler = completeOAuthHandler({ store: memoryStore(), callback });

    const res = (await handler(callbackRequest({ error: 'access_denied' }))) as Response;

    expect(res.status).toBe(400);
    expect(callback).not.toHaveBeenCalled();
  });
});
