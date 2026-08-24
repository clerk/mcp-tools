import { McpServer, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { NextRequest } from 'next/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { completeAuthWithCode } from '../client';
import { completeOAuthHandler, protectedResourceHandler, streamableHttpHandler } from './index';

vi.mock('../client', () => ({
  completeAuthWithCode: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
}));

const authInfo: AuthInfo = {
  token: 'valid-token',
  scopes: ['read'],
  clientId: 'client-1',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
const legacyInitializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
});

function createMcpServer() {
  return new McpServer({ name: 'test-server', version: '1.0.0' });
}

function nextRequest(url: string, init?: RequestInit): NextRequest {
  const nextUrl = new URL(url);
  return Object.assign(new Request(nextUrl, init), { nextUrl }) as NextRequest;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Next adapter', () => {
  test('forwards all OAuth callback parameters to the client', async () => {
    const callback = vi.fn();
    const store = {
      read: vi.fn(),
      write: vi.fn(),
    };
    const handler = completeOAuthHandler({ store, callback });
    const request = nextRequest(
      'https://app.example.com/oauth/callback?code=code-1&state=state-1&iss=https%3A%2F%2Fauth.example.com&custom=value',
    );

    await handler(request);

    expect(completeAuthWithCode).toHaveBeenCalledWith({
      callbackParams: request.nextUrl.searchParams,
      store,
    });
    expect(callback).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  test('forwards OAuth error callbacks without requiring a code', async () => {
    const callback = vi.fn();
    const store = {
      read: vi.fn(),
      write: vi.fn(),
    };
    const handler = completeOAuthHandler({ store, callback });
    const request = nextRequest(
      'https://app.example.com/oauth/callback?error=access_denied&error_description=Denied&state=state-1&iss=https%3A%2F%2Fauth.example.com',
    );

    await handler(request);

    expect(completeAuthWithCode).toHaveBeenCalledWith({
      callbackParams: request.nextUrl.searchParams,
      store,
    });
  });

  test('returns path-aware protected resource metadata', async () => {
    const handler = protectedResourceHandler({ authServerUrl: 'https://auth.example.com' });

    const response = handler(
      new Request('https://app.example.com/.well-known/oauth-protected-resource/mcp?ignored=true'),
    );
    const metadata = await response.json();

    expect(metadata.resource).toBe('https://app.example.com/mcp');
    expect(metadata.authorization_servers).toEqual(['https://auth.example.com']);
  });

  test('returns a path-aware SDK bearer challenge', async () => {
    const verifier: OAuthTokenVerifier = { verifyAccessToken: vi.fn() };
    const handler = streamableHttpHandler(createMcpServer, { auth: { verifier } });

    const response = await handler(nextRequest('https://app.example.com/mcp'));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('serves POST and accepts GET and DELETE route composition', async () => {
    const handler = streamableHttpHandler(createMcpServer);
    const postResponse = await handler(
      nextRequest('https://app.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: legacyInitializeBody,
      }),
    );
    const getResponse = await handler(
      nextRequest('https://app.example.com/mcp', { method: 'GET' }),
    );
    const deleteResponse = await handler(
      nextRequest('https://app.example.com/mcp', { method: 'DELETE' }),
    );

    expect(postResponse.status).toBe(200);
    expect(getResponse.status).toBe(405);
    expect(deleteResponse.status).toBe(405);
  });

  test('passes auth to an isolated server instance for every request', async () => {
    const verifier: OAuthTokenVerifier = {
      verifyAccessToken: vi.fn().mockResolvedValue(authInfo),
    };
    const factory = vi.fn(() => createMcpServer());
    const handler = streamableHttpHandler(factory, { auth: { verifier } });
    const request = () =>
      nextRequest('https://app.example.com/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: legacyInitializeBody,
      });

    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(200);

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
