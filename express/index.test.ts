import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport as Transport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { type AddressInfo, connect } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The default client, which `mcpAuth` loads with `import()` when there is no `clerkClient` option. A test sets
// `clerkExpressLoad.error` to make that load fail. Every registration of the mock uses this one factory: Vitest
// registers the `vi.doMock` calls queued for one path in parallel, so with different factories a later call would
// not reliably replace an earlier one.
const clerkExpressLoad = vi.hoisted(() => {
  const load = {
    error: undefined as Error | undefined,
    clerkClient: { authenticateRequest: vi.fn() },
    factory: () => {
      if (load.error) throw load.error;
      return { clerkClient: load.clerkClient };
    },
  };
  return load;
});
vi.mock('@clerk/express', () => clerkExpressLoad.factory());

import { clerkClient } from '@clerk/express';
import {
  McpAuthError,
  type McpAuthFailure,
  type McpAuthOptions,
  McpTokenVerificationError,
  mcpAuth,
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
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
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
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
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
  test.each([
    ['mcpAuth({ verifyToken })', () => (mcpAuth as (...args: unknown[]) => unknown)(reject)],
    [
      'mcpAuth(verifyToken, options)',
      () => (mcpAuth as (...args: unknown[]) => unknown)(reject, { resourceUrl }),
    ],
  ])('throws a Clerk error naming the options form for %s', (_form, call) => {
    expect(call).toThrow('Clerk error: mcpAuth takes an options object');
    expect(call).toThrow('mcpAuth({ verifyToken })');
  });

  test('works as a middleware without await', () => {
    expect(() => express().post('/mcp', mcpAuth({ verifyToken: reject }))).not.toThrow();
  });

  test.each([[resourceUrl], [undefined]])(
    'calls verifyToken with the token and the request instead of Clerk (resourceUrl: %j)',
    async (listed) => {
      const authenticateRequest = vi.mocked(clerkClient.authenticateRequest);
      authenticateRequest.mockReset();
      const verifyToken = vi.fn(async (token: string, req: express.Request) => ({
        token,
        scopes: [],
        clientId: req.path,
      }));
      const app = express();
      app.set('trust proxy', true);
      app.post('/mcp', mcpAuth({ verifyToken, resourceUrl: listed }), (req, res) => {
        res.json({ auth: (req as unknown as { auth: unknown }).auth });
      });

      const res = await withListening(app, (baseUrl) =>
        fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer my-token',
            'X-Forwarded-Host': 'mcp.example.com',
            'X-Forwarded-Proto': 'https',
          },
        }),
      );

      expect(res.status).toBe(200);
      expect(verifyToken).toHaveBeenCalledOnce();
      expect(verifyToken.mock.calls[0]?.[0]).toBe('my-token');
      expect(verifyToken.mock.calls[0]?.[1].path).toBe('/mcp');
      expect(authenticateRequest).not.toHaveBeenCalled();
      expect(await res.json()).toEqual({
        auth: { token: 'my-token', scopes: [], clientId: '/mcp', resourceMetadataUrl: metadataUrl },
      });
    },
  );

  test('sends a quoted challenge when the Authorization header is missing', async () => {
    const res = await request(mcpAuth({ verifyToken: reject }));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test('leaves the query string out of resource_metadata', async () => {
    const res = await request(mcpAuth({ verifyToken: reject }), { path: '/mcp?x=1' });

    expect(res.challenge).toBe(
      `Bearer resource_metadata="${res.origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test('derives resource_metadata from resourceUrl instead of the request', async () => {
    const res = await request(mcpAuth({ verifyToken: reject, resourceUrl }));

    expect(res.challenge).toBe(`Bearer resource_metadata="${metadataUrl}"`);
  });

  test('derives resource_metadata from the listed resourceUrl with the request origin', async () => {
    // The test server's port is only known once it listens, so the middleware is built per request
    const res = await request((req, res, next) =>
      mcpAuth({
        verifyToken: reject,
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
      mcpAuth({
        verifyToken,
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
      app.post('/mcp', mcpAuth({ verifyToken: reject, resourceUrl: listed }), (_req, res) => {
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

      const res = await request(mcpAuth({ verifyToken, resourceUrl }), {
        authorization,
      });

      expect(res.status).toBe(401);
      expect(res.challenge).toBe(`Bearer resource_metadata="${metadataUrl}"`);
      expect(verifyToken).not.toHaveBeenCalled();
    },
  );

  test('adds invalid_token to the challenge when the token is rejected', async () => {
    const res = await request(mcpAuth({ verifyToken: reject, resourceUrl }), {
      authorization: 'Bearer bad',
    });

    expect(res.status).toBe(401);
    expect(res.challenge).toBe(`Bearer resource_metadata="${metadataUrl}", error="invalid_token"`);
  });

  test('returns 403 with the granted and missing scopes when requiredScopes are missing', async () => {
    const res = await request(
      mcpAuth({
        verifyToken: async () => ({ token: 't', scopes: ['openid'], clientId: 'c' }),
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
      mcpAuth({ verifyToken: async () => authInfo, requiredScopes: ['profile'] }),
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
      mcpAuth({
        verifyToken: async () => ({ token: 't', scopes: [], clientId: 'c' }),
        resourceUrl,
      }),
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
      expect(() => mcpAuth({ verifyToken: reject, resourceUrl })).toThrow(
        'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL without credentials',
      );
      expect(() =>
        mcpAuth({ verifyToken: reject, resourceUrl: ['https://mcp.example.com/mcp', resourceUrl] }),
      ).toThrow(
        'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL without credentials',
      );
    }
    expect(() => mcpAuth({ verifyToken: reject, resourceUrl: [] })).toThrow(
      'Clerk error: mcpAuth resourceUrl must be a URL or a non-empty list of URLs',
    );
    expect(() =>
      mcpAuth({
        verifyToken: reject,
        resourceUrl: ['https://mcp.example.com/a', 'https://mcp.example.com/b'],
      }),
    ).toThrow(
      'Clerk error: mcpAuth resourceUrl lists more than one URL for https://mcp.example.com',
    );
    expect(() => mcpAuth({ verifyToken: reject, requiredScopes: ['a b'] })).toThrow(
      'Clerk error: mcpAuth requiredScopes must contain only scope tokens',
    );
    expect(() => mcpAuth({ verifyToken: reject, challengeScopes: [''] })).toThrow(
      'Clerk error: mcpAuth challengeScopes must contain only scope tokens',
    );
  });

  test('lists requiredScopes then challengeScopes in the 401 challenge', async () => {
    const res = await request(
      mcpAuth({
        verifyToken: reject,
        resourceUrl,
        requiredScopes: ['profile'],
        challengeScopes: ['email'],
      }),
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
      mcpAuth({ verifyToken: async () => authInfo, requiredScopes: ['profile'] }),
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
      mcpAuth({
        verifyToken: async () => {
          throw cause;
        },
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
      mcpAuth({
        verifyToken: async () => {
          throw Object.assign(new Error('unavailable'), { status: 503 });
        },
      }),
    );

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer t' } }),
    );
    consoleError.mockRestore();

    expect(res.status).toBe(503);
  });

  test('keeps a 5xx status from the verifier error in the JSON answer', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.post(
      '/mcp',
      mcpAuth({
        verifyToken: async () => {
          throw Object.assign(new Error('unavailable'), { status: 503 });
        },
      }),
    );

    const res = await withListening(app, async (baseUrl) => {
      const answer = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
      });
      return { status: answer.status, body: await answer.json() };
    });
    consoleError.mockRestore();

    expect(res).toEqual({ status: 503, body: { error: 'server_error' } });
  });

  test.each([401, 429])(
    "answers 500 when the verifier error's status is %i, which is not the client's to act on",
    async (status) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const app = express();
      app.post(
        '/mcp',
        mcpAuth({
          verifyToken: async () => {
            throw Object.assign(new Error('introspection failed'), { status });
          },
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

  test('answers an McpAuthError with a JSON server error, not the default HTML error page', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.post(
      '/mcp',
      mcpAuth({
        verifyToken: async () => {
          throw new Error('network down');
        },
      }),
    );

    const res = await withListening(app, async (baseUrl) => {
      const answer = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
      });
      return {
        status: answer.status,
        type: answer.headers.get('content-type'),
        body: await answer.text(),
      };
    });
    consoleError.mockRestore();

    expect(res.status).toBe(500);
    expect(res.type).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual({ error: 'server_error' });
  });

  test('passes the McpAuthError to error middleware once the JSON answer has been sent', async () => {
    const seen: { err: unknown; headersSent: boolean }[] = [];
    const app = express();
    app.post(
      '/mcp',
      mcpAuth({
        verifyToken: async () => {
          throw new Error('network down');
        },
      }),
    );
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
        seen.push({ err, headersSent: res.headersSent });
        if (!res.headersSent) next(err);
      },
    );

    const res = await withListening(app, async (baseUrl) => {
      const answer = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
      });
      const body = await answer.json();
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      return { status: answer.status, body };
    });

    expect(res).toEqual({ status: 500, body: { error: 'server_error' } });
    expect(seen[0]!.err).toBeInstanceOf(McpAuthError);
    expect(seen[0]!.headersSent).toBe(true);
  });

  test.each([undefined, ['https://mcp.example.com/mcp']])(
    'answers a Host header that does not parse with a 400 (resourceUrl: %j)',
    async (listed) => {
      const verifyToken = vi.fn();
      const app = express();
      app.post('/mcp', mcpAuth({ verifyToken, resourceUrl: listed }), (_req, res) => {
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
    app.post('/mcp', mcpAuth({ verifyToken }), (_req, res) => {
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
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('mcpAuth with Clerk', () => {
  const authenticateRequest = vi.mocked(clerkClient.authenticateRequest);
  const authenticated = (scopes: string[]) =>
    ({
      isAuthenticated: true,
      toAuth: () => ({
        isAuthenticated: true,
        tokenType: 'oauth_token',
        id: 'oat_1',
        subject: 'user-1',
        getToken: async () => 'token',
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
    app.post('/mcp', mcpAuth as unknown as express.RequestHandler, (_req, res) => {
      res.json({ ok: true });
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toContain('Clerk error: mcpAuth needs a resourceUrl');
    } finally {
      server.closeAllConnections();
      server.close();
      consoleError.mockRestore();
    }
  });

  test('throws a Clerk error without a resourceUrl', () => {
    expect(() => mcpAuth({} as never)).toThrow('Clerk error: mcpAuth needs a resourceUrl');
  });

  test('answers a bare Bearer header with a 401 instead of hanging', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const res = await request(mcpAuth({ resourceUrl }), { authorization: 'Bearer' });
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);

    expect(res.status).toBe(401);
    expect(unhandled).not.toHaveBeenCalled();
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  test('asks Clerk to check the audience and sets req.auth', async () => {
    authenticateRequest.mockResolvedValue(authenticated(['profile']));

    const res = await request(mcpAuth({ resourceUrl, requiredScopes: ['profile'] }), {
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

    const res = await request(mcpAuth({ resourceUrl }), { authorization: 'Bearer bad' });

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
    app.post('/mcp', mcpAuth({ resourceUrl }), (_req, res) => {
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
      app.post('/mcp', mcpAuth({ resourceUrl }));
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

    const res = await request(mcpAuth({ resourceUrl }), { authorization: 'Bearer t' });

    expect(res.status).toBe(500);
    expect(res.challenge).toBeNull();
  });

  test('verifies with the clerkClient option instead of the default client', async () => {
    const client = { authenticateRequest: vi.fn().mockResolvedValue(authenticated(['profile'])) };

    const res = await request(mcpAuth({ resourceUrl, clerkClient: client as never }), {
      authorization: 'Bearer t',
    });

    expect(res.status).toBe(200);
    expect(client.authenticateRequest).toHaveBeenCalledOnce();
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  test('answers a token without the required scopes with a 403 challenge', async () => {
    authenticateRequest.mockResolvedValue(authenticated(['openid']));

    const res = await request(mcpAuth({ resourceUrl, requiredScopes: ['profile'] }), {
      authorization: 'Bearer t',
    });

    expect(res.status).toBe(403);
    expect(res.challenge).toBe(
      `Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", scope="openid profile"`,
    );
  });
});

describe('mcpAuth without @clerk/express installed', () => {
  const loadError = new Error('Cannot find package @clerk/express');

  // `vi.resetModules()` keeps loaded mocks, so registering the mock again is what drops the loaded one. The next
  // import of `@clerk/express` then runs the factory, which throws.
  beforeEach(() => {
    clerkExpressLoad.error = loadError;
    vi.doMock('@clerk/express', clerkExpressLoad.factory);
    vi.resetModules();
  });

  afterEach(() => {
    // Back to the mock the other tests use, which later imports of `@clerk/express` load again
    clerkExpressLoad.error = undefined;
    vi.doMock('@clerk/express', clerkExpressLoad.factory);
    vi.resetModules();
  });

  // A fresh module graph, so the adapter is loaded while `@clerk/express` can't be
  async function post(options: McpAuthOptions, authorization?: string) {
    const adapter = await import('./index');
    const errors: unknown[] = [];
    const app = express();
    app.post('/mcp', adapter.mcpAuth(options), (_req, res) => {
      res.json({ reached: true });
    });
    app.use(((error, _req, res, _next) => {
      errors.push(error);
      res.status(500).json({});
    }) satisfies express.ErrorRequestHandler);

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: authorization === undefined ? {} : { Authorization: authorization },
      }),
    );
    return { status: res.status, errors, McpAuthError: adapter.McpAuthError };
  }

  // A setup mistake is thrown as it is, not as the cause of an `McpAuthError`, and before any token arrives
  test.each([
    ['with a token', 'Bearer token-1'],
    ['without a token', undefined],
  ])(
    'throws a Clerk error asking to install @clerk/express %s, with the load error as the cause',
    async (_case, authorization) => {
      const res = await post({ resourceUrl }, authorization);

      expect(res.status).toBe(500);
      expect(res.errors).toHaveLength(1);
      const error = res.errors[0] as Error;
      expect(error).not.toBeInstanceOf(res.McpAuthError);
      expect(error.message).toBe(
        'Clerk error: install @clerk/express, or pass clerkClient to mcpAuth',
      );
      // Vitest wraps an error thrown by a mock factory in its own, with the original as that error's cause
      const { cause } = error;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).cause).toBe(loadError);
    },
  );

  test('verifies with verifyToken without loading @clerk/express', async () => {
    const verifyToken = vi.fn(async () => undefined);

    const res = await post({ verifyToken }, 'Bearer token-1');

    expect(res.status).toBe(401);
    expect(res.errors).toEqual([]);
    expect(verifyToken).toHaveBeenCalledOnce();
  });

  test('verifies with the clerkClient option without loading @clerk/express', async () => {
    const authenticateRequest = vi.fn().mockResolvedValue({ isAuthenticated: false });

    const res = await post({ resourceUrl, clerkClient: { authenticateRequest } }, 'Bearer token-1');

    expect(res.status).toBe(401);
    expect(res.errors).toEqual([]);
    expect(authenticateRequest).toHaveBeenCalledOnce();
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

  test.each(['GET', 'DELETE'])(
    'answers a %s with a 405 and Allow: POST, without building a server',
    async (method) => {
      const createServer = vi.fn(createMcpServer);
      const app = express();
      app.use(express.json());
      app.all('/mcp', streamableHttpHandler(createServer, Transport));
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method,
          headers: { accept: 'application/json, text/event-stream' },
          signal: AbortSignal.timeout(2000),
        });

        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
        expect(await res.json()).toEqual({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        });
        expect(createServer).not.toHaveBeenCalled();
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
});
