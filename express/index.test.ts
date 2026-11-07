import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@clerk/express', () => ({
  clerkClient: { authenticateRequest: vi.fn() },
}));

import { clerkClient } from '@clerk/express';
import { mcpAuth, mcpAuthClerk, streamableHttpHandler } from './index';

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

async function request(
  middleware: express.RequestHandler,
  { path = '/mcp', authorization }: { path?: string; authorization?: string } = {},
) {
  const app = express();
  app.post('/mcp', middleware, (req, res) => {
    res.json({ auth: (req as unknown as { auth: unknown }).auth });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: authorization === undefined ? {} : { Authorization: authorization },
      signal: AbortSignal.timeout(2000),
    });
    return {
      status: res.status,
      challenge: res.headers.get('WWW-Authenticate'),
      body: await res.json(),
      origin: `http://127.0.0.1:${port}`,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const reject = async () => undefined;
const metadataUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const resourceUrl = 'https://mcp.example.com/mcp';

describe('mcpAuth', () => {
  test('works as a middleware without await', () => {
    expect(() => express().post('/mcp', mcpAuth(reject))).not.toThrow();
  });

  test('sends a quoted challenge when the Authorization header is missing', async () => {
    const res = await request(mcpAuth(reject));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test('leaves the query string out of resource_metadata', async () => {
    const res = await request(mcpAuth(reject), { path: '/mcp?x=1' });

    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test('derives resource_metadata from resourceUrl instead of the request', async () => {
    const res = await request(mcpAuth(reject, { resourceUrl }));

    expect(res.challenge).toBe(`Bearer resource_metadata="${metadataUrl}"`);
  });

  test.each(['Bearer', 'Basic abc', 'Bearer a b'])(
    'answers the malformed header %j with a 401 challenge and does not verify it',
    async (authorization) => {
      const verifyToken = vi.fn(reject);

      const res = await request(mcpAuth(verifyToken, { resourceUrl }), { authorization });

      expect(res.status).toBe(401);
      expect(res.challenge).toBe(`Bearer resource_metadata="${metadataUrl}"`);
      expect(verifyToken).not.toHaveBeenCalled();
    },
  );

  test('adds invalid_token to the challenge when the token is rejected', async () => {
    const res = await request(mcpAuth(reject, { resourceUrl }), { authorization: 'Bearer bad' });

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(`Bearer resource_metadata="${metadataUrl}", error="invalid_token"`);
  });

  test('returns 403 with the granted and missing scopes when requiredScopes are missing', async () => {
    const res = await request(
      mcpAuth(async () => ({ token: 't', scopes: ['openid'], clientId: 'c' }), {
        resourceUrl,
        requiredScopes: ['profile', 'email'],
      }),
      { authorization: 'Bearer t' },
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'insufficient_scope' });
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", scope="openid profile email"`,
    );
  });

  test('sets req.auth and calls next when the token has every required scope', async () => {
    const authInfo = { token: 't', scopes: ['profile'], clientId: 'c' };

    const res = await request(
      mcpAuth(async () => authInfo, { requiredScopes: ['profile'] }),
      {
        authorization: 'Bearer t',
      },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ auth: authInfo });
  });

  test('throws at setup for an invalid resourceUrl or scope', () => {
    expect(() => mcpAuth(reject, { resourceUrl: '/mcp' })).toThrow(
      'Clerk error: mcpAuth resourceUrl must be an absolute URL',
    );
    expect(() => mcpAuth(reject, { requiredScopes: ['a b'] })).toThrow(
      'Clerk error: mcpAuth requiredScopes must contain only scope tokens',
    );
  });
});

describe('mcpAuthClerk', () => {
  const authenticateRequest = vi.mocked(clerkClient.authenticateRequest);
  const authenticated = (scopes: string[]) =>
    ({
      isAuthenticated: true,
      toAuth: () => ({
        isAuthenticated: true,
        tokenType: 'oauth_token',
        clientId: 'client-1',
        scopes,
        userId: 'user-1',
      }),
    }) as never;

  beforeEach(() => {
    authenticateRequest.mockReset();
  });

  test('fails loudly instead of hanging when passed to a route without being called', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.post('/mcp', mcpAuthClerk as unknown as express.RequestHandler, (_req, res) => {
      res.json({ ok: true });
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toContain('Clerk error: mcpAuthClerk needs a resourceUrl');
    } finally {
      server.closeAllConnections();
      server.close();
      consoleError.mockRestore();
    }
  });

  test('throws a Clerk error without a resourceUrl', () => {
    expect(() => mcpAuthClerk({} as never)).toThrow(
      'Clerk error: mcpAuthClerk needs a resourceUrl',
    );
  });

  test('answers a bare Bearer header with a 401 instead of hanging', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const res = await request(mcpAuthClerk({ resourceUrl }), { authorization: 'Bearer' });
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);

    expect(res.status).toBe(401);
    expect(unhandled).not.toHaveBeenCalled();
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  test('asks Clerk to check the audience and sets req.auth', async () => {
    authenticateRequest.mockResolvedValue(authenticated(['profile']));

    const res = await request(mcpAuthClerk({ resourceUrl, requiredScopes: ['profile'] }), {
      authorization: 'Bearer token-1',
    });

    expect(res.status).toBe(200);
    const [verified, options] = authenticateRequest.mock.calls[0]!;
    expect(verified.headers.get('authorization')).toBe('Bearer token-1');
    expect(options).toEqual({ acceptsToken: 'oauth_token', audience: resourceUrl });
    expect(res.body.auth).toMatchObject({ clientId: 'client-1', extra: { userId: 'user-1' } });
  });

  test('answers a rejected token with the invalid_token challenge', async () => {
    authenticateRequest.mockResolvedValue({ isAuthenticated: false } as never);

    const res = await request(mcpAuthClerk({ resourceUrl }), { authorization: 'Bearer bad' });

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(`Bearer resource_metadata="${metadataUrl}", error="invalid_token"`);
  });

  test('answers a verification failure with the invalid_token challenge', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    authenticateRequest.mockRejectedValue(new Error('network down'));

    const res = await request(mcpAuthClerk({ resourceUrl }), { authorization: 'Bearer t' });

    expect(res.status).toBe(401);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('answers a token without the required scopes with a 403 challenge', async () => {
    authenticateRequest.mockResolvedValue(authenticated(['openid']));

    const res = await request(mcpAuthClerk({ resourceUrl, requiredScopes: ['profile'] }), {
      authorization: 'Bearer t',
    });

    expect(res.status).toBe(403);
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", scope="openid profile"`,
    );
  });
});

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
