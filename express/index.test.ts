import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport as Transport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { type AddressInfo, connect } from 'node:net';
import type { Server } from 'node:http';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@clerk/express', () => ({
  clerkClient: { authenticateRequest: vi.fn() },
}));

import { clerkClient } from '@clerk/express';
import {
  McpAuthError,
  type McpAuthFailure,
  McpTokenVerificationError,
  mcpAuth,
  mcpAuthClerk,
  streamableHttpHandler,
} from './index';

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
      // Express's default error handler answers with HTML.
      body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(),
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

  test('derives resource_metadata from the listed resourceUrl with the request origin', async () => {
    // The test server's port is only known once it listens, so the middleware is built per request
    const res = await request((req, res, next) =>
      mcpAuth(reject, {
        resourceUrl: ['https://mcp.example.com/mcp', `http://${req.get('host')}/mcp`],
      })(req, res, next),
    );

    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test('answers a request to an unlisted origin with a 421 and does not verify it', async () => {
    const verifyToken = vi.fn(reject);
    const res = await request(
      mcpAuth(verifyToken, {
        resourceUrl: ['https://mcp.example.com/mcp', 'https://mcp.example.dev/mcp'],
      }),
      { authorization: 'Bearer token-1' },
    );

    expect(res.status).toBe(421);
    expect(res.challenge).toBeNull();
    expect(res.body).toEqual({ error: 'misdirected_request' });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test.each([[[resourceUrl]], [undefined]])(
    'reads the origin from X-Forwarded-Host and X-Forwarded-Proto under trust proxy (resourceUrl: %j)',
    async (listed) => {
      const app = express();
      app.set('trust proxy', true);
      app.post('/mcp', mcpAuth(reject, { resourceUrl: listed }), (_req, res) => {
        res.json({});
      });

      const res = await withListening(app, (baseUrl) =>
        fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { 'X-Forwarded-Host': 'mcp.example.com', 'X-Forwarded-Proto': 'https' },
        }),
      );

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${metadataUrl}"`);
    },
  );

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
    expect(res.body).toEqual({
      auth: {
        ...authInfo,
        resourceMetadataUrl: `${res.origin}/.well-known/oauth-protected-resource/mcp`,
      },
    });
  });

  test('sets resourceMetadataUrl on req.auth from resourceUrl', async () => {
    const res = await request(
      mcpAuth(async () => ({ token: 't', scopes: [], clientId: 'c' }), { resourceUrl }),
      { authorization: 'Bearer t' },
    );

    expect(res.body.auth.resourceMetadataUrl).toBe(metadataUrl);
  });

  test('throws at setup for an invalid resourceUrl or scope', () => {
    for (const resourceUrl of [
      '/mcp',
      'mailto:foo@example.com',
      'https://user:pass@mcp.example.com/mcp',
    ]) {
      expect(() => mcpAuth(reject, { resourceUrl })).toThrow(
        'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL without credentials',
      );
      expect(() =>
        mcpAuth(reject, { resourceUrl: ['https://mcp.example.com/mcp', resourceUrl] }),
      ).toThrow(
        'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL without credentials',
      );
    }
    expect(() => mcpAuth(reject, { resourceUrl: [] })).toThrow(
      'Clerk error: mcpAuth resourceUrl must be a URL or a non-empty list of URLs',
    );
    expect(() =>
      mcpAuth(reject, { resourceUrl: ['https://mcp.example.com/a', 'https://mcp.example.com/b'] }),
    ).toThrow(
      'Clerk error: mcpAuth resourceUrl lists more than one URL for https://mcp.example.com',
    );
    expect(() => mcpAuth(reject, { requiredScopes: ['a b'] })).toThrow(
      'Clerk error: mcpAuth requiredScopes must contain only scope tokens',
    );
    expect(() => mcpAuth(reject, { challengeScopes: [''] })).toThrow(
      'Clerk error: mcpAuth challengeScopes must contain only scope tokens',
    );
  });

  test('lists requiredScopes then challengeScopes in the 401 challenge', async () => {
    const res = await request(
      mcpAuth(reject, { resourceUrl, requiredScopes: ['profile'], challengeScopes: ['email'] }),
    );

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(`Bearer resource_metadata="${metadataUrl}", scope="profile email"`);
  });

  test.each([
    ['missing_token', undefined, undefined],
    ['malformed_token', 'Basic abc', undefined],
    ['invalid_token', 'Bearer bad', undefined],
    ['insufficient_scope', 'Bearer t', { token: 't', scopes: [], clientId: 'c' }],
  ])('records %s on res.locals.mcpAuthFailure', async (reason, authorization, authInfo) => {
    const failures: unknown[] = [];
    const app = express();
    app.use((_req, res, next) => {
      res.on('finish', () => failures.push(res.locals.mcpAuthFailure));
      next();
    });
    app.post(
      '/mcp',
      mcpAuth(async () => authInfo, { requiredScopes: ['profile'] }),
      (_req, res) => {
        res.json({});
      },
    );

    await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: authorization === undefined ? {} : { Authorization: authorization },
      }),
    );

    expect(failures).toEqual([{ reason }]);
  });

  test('passes an McpAuthError with the verifier error as its cause to the error handler', async () => {
    const cause = new Error('network down');
    const errors: unknown[] = [];
    const app = express();
    app.post(
      '/mcp',
      mcpAuth(async () => {
        throw cause;
      }),
    );
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        errors.push(err);
        res.status(500).end();
      },
    );

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer t' } }),
    );

    expect(res.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(McpAuthError);
    expect(errors[0]).toMatchObject({ reason: 'verification_failed', cause });
  });

  test("keeps the verifier error's status for Express's default error handler", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.post(
      '/mcp',
      mcpAuth(async () => {
        throw Object.assign(new Error('unavailable'), { status: 503 });
      }),
    );

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer t' } }),
    );
    consoleError.mockRestore();

    expect(res.status).toBe(503);
  });

  test.each([401, 429])(
    "answers 500 when the verifier error's status is %i, which is not the client's to act on",
    async (status) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const app = express();
      app.post(
        '/mcp',
        mcpAuth(async () => {
          throw Object.assign(new Error('introspection failed'), { status });
        }),
      );

      const res = await withListening(app, (baseUrl) =>
        fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer t' } }),
      );
      consoleError.mockRestore();

      expect(res.status).toBe(500);
      expect(res.headers.get('WWW-Authenticate')).toBeNull();
    },
  );

  test.each([undefined, ['https://mcp.example.com/mcp']])(
    'answers a Host header that does not parse with a 400 (resourceUrl: %j)',
    async (listed) => {
      const verifyToken = vi.fn();
      const app = express();
      app.post('/mcp', mcpAuth(verifyToken, { resourceUrl: listed }), (_req, res) => {
        res.json({});
      });

      const status = await withListening(app, (baseUrl) => {
        const { port } = new URL(baseUrl);
        return new Promise<string>((resolve, reject) => {
          const socket = connect(Number(port), '127.0.0.1', () => {
            socket.write(
              'POST /mcp HTTP/1.1\r\nHost: [\r\nAuthorization: Bearer t\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
            );
          });
          let response = '';
          socket.on('data', (chunk) => (response += chunk.toString()));
          socket.on('end', () => resolve(response.split('\r\n')[0] ?? ''));
          socket.on('error', reject);
        });
      });

      expect(status).toBe('HTTP/1.1 400 Bad Request');
      expect(verifyToken).not.toHaveBeenCalled();
    },
  );

  test('answers an HTTP/1.0 request without a Host header with a 400 instead of using http://undefined', async () => {
    const verifyToken = vi.fn();
    const app = express();
    app.post('/mcp', mcpAuth(verifyToken), (_req, res) => {
      res.json({});
    });

    const response = await withListening(app, (baseUrl) => {
      const { port } = new URL(baseUrl);
      return new Promise<string>((resolve, reject) => {
        const socket = connect(Number(port), '127.0.0.1', () => {
          socket.write(
            'POST /mcp HTTP/1.0\r\nAuthorization: Bearer t\r\nContent-Length: 0\r\n\r\n',
          );
        });
        let response = '';
        socket.on('data', (chunk) => (response += chunk.toString()));
        socket.on('end', () => resolve(response));
        socket.on('error', reject);
      });
    });

    expect(response).toMatch(/^HTTP\/1\.[01] 400 Bad Request/);
    expect(response).not.toContain('undefined');
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

async function withListening<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

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

  test('records what Clerk reported for a rejected token on res.locals.mcpAuthFailure', async () => {
    authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      reason: 'token-verification-failed',
      message: 'JWT is expired. (code=token-verification-failed, status=n/a)',
    } as never);
    const failures: unknown[] = [];
    const app = express();
    app.use((_req, res, next) => {
      res.on('finish', () => failures.push(res.locals.mcpAuthFailure));
      next();
    });
    app.post('/mcp', mcpAuthClerk({ resourceUrl }), (_req, res) => {
      res.json({});
    });

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer bad' } }),
    );

    const [failure] = failures as McpAuthFailure[];
    expect(failure?.reason).toBe('invalid_token');
    expect(failure?.cause).toBeInstanceOf(McpTokenVerificationError);
    expect(failure?.cause).toMatchObject({
      code: 'token-verification-failed',
      message: 'JWT is expired. (code=token-verification-failed, status=n/a)',
    });
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${metadataUrl}", error="invalid_token"`,
    );
  });

  test.each(['unexpected-error', 'secret-key-invalid'])(
    'answers a %s verification failure with a 500 instead of a challenge',
    async (reason) => {
      authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
        reason,
        message: 'Unexpected error',
      } as never);
      const errors: unknown[] = [];
      const app = express();
      app.post('/mcp', mcpAuthClerk({ resourceUrl }));
      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          errors.push(err);
          res.status(500).end();
        },
      );

      const res = await withListening(app, (baseUrl) =>
        fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer t' } }),
      );

      expect(res.status).toBe(500);
      expect(res.headers.get('WWW-Authenticate')).toBeNull();
      expect(errors[0]).toBeInstanceOf(McpAuthError);
      const { cause } = errors[0] as McpAuthError;
      expect(cause).toBeInstanceOf(McpTokenVerificationError);
      expect(cause).toMatchObject({ code: reason, message: 'Unexpected error' });
    },
  );

  test('answers a thrown verification error with a 500 instead of a challenge', async () => {
    authenticateRequest.mockRejectedValue(new Error('network down'));

    const res = await request(mcpAuthClerk({ resourceUrl }), { authorization: 'Bearer t' });

    expect(res.status).toBe(500);
    expect(res.challenge).toBeNull();
  });

  test('verifies with the clerkClient option instead of the default client', async () => {
    const client = { authenticateRequest: vi.fn().mockResolvedValue(authenticated(['profile'])) };

    const res = await request(mcpAuthClerk({ resourceUrl, clerkClient: client as never }), {
      authorization: 'Bearer t',
    });

    expect(res.status).toBe(200);
    expect(client.authenticateRequest).toHaveBeenCalledOnce();
    expect(authenticateRequest).not.toHaveBeenCalled();
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
    await withApp(streamableHttpHandler(createMcpServer, Transport), async (baseUrl) => {
      const res = await postInitialize(baseUrl);
      expect(res.status).toBe(200);
      await res.text();
    });
  });

  test('throws at setup without the transport class', () => {
    // @ts-expect-error the transport class is required
    expect(() => streamableHttpHandler(createMcpServer)).toThrow(
      "Clerk error: streamableHttpHandler needs the MCP SDK transport class as its second argument. Import StreamableHTTPServerTransport from '@modelcontextprotocol/sdk/server/streamableHttp.js'",
    );
  });

  test('handles sequential requests', async () => {
    const createServer = vi.fn(createMcpServer);
    await withApp(streamableHttpHandler(createServer, Transport), async (baseUrl) => {
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
    await withApp(streamableHttpHandler(createMcpServer, Transport), async (baseUrl) => {
      const [res1, res2] = await Promise.all([postInitialize(baseUrl), postInitialize(baseUrl)]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      await res1.text();
      await res2.text();
    });
  });

  test('throws at setup when given a server object instead of a factory', () => {
    // @ts-expect-error a shared server object is not accepted
    expect(() => streamableHttpHandler(createMcpServer(), Transport)).toThrow(
      'Clerk error: streamableHttpHandler needs a function that returns a new MCP server as its first argument, so each request gets its own server. Call streamableHttpHandler(() => new McpServer(...), StreamableHTTPServerTransport) instead of passing a server object',
    );
  });
});
