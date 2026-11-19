import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport as Transport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { request as httpRequest } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The default client, which `mcpAuth` loads with `import()` when there is no `clerkClient` option. A test sets
// `clerkExpressLoad.error` to make that load fail. Every registration of the mock uses this one factory: Vitest
// registers the `vi.doMock` calls queued for one path in parallel, so with different factories a later call would
// not reliably replace an earlier one. Like the real client, it throws when the keys it reads from the environment
// are not set, and a test mocks what Clerk answered otherwise.
const clerkExpressLoad = vi.hoisted(() => {
  const load = {
    error: undefined as Error | undefined,
    clerkClient: {
      authenticateRequest: vi.fn(async (): Promise<unknown> => {
        if (!process.env.CLERK_PUBLISHABLE_KEY) throw new Error('Publishable key is missing.');
        throw new Error('authenticateRequest is not mocked for this test');
      }),
    },
    factory: () => {
      if (load.error) throw load.error;
      return { clerkClient: load.clerkClient };
    },
  };
  return load;
});
vi.mock('@clerk/express', () => clerkExpressLoad.factory());

import { clerkClient } from '@clerk/express';
import { FAKE_PK, expiresAt, sendRaw, withListening } from '../test/mcp-harness';
import {
  McpAuthError,
  type McpAuthOptions,
  aiCatalogHandler,
  mcpAuth,
  protectedResourceMetadataHandler,
  serverCardHandler,
  streamableHttpHandler,
} from './index';

function createMcpServer() {
  return new McpServer({ name: 'test-server', version: '1.0.0' });
}

function withApp<T>(
  handler: ReturnType<typeof streamableHttpHandler>,
  fn: (baseUrl: string) => Promise<T>,
) {
  const app = express();
  app.use(express.json());
  app.all('/mcp', handler);
  return withListening(app, fn);
}

function postInitialize(baseUrl: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });
}

function request(
  middleware: express.RequestHandler,
  { path = '/mcp', authorization }: { path?: string; authorization?: string } = {},
) {
  const app = express();
  app.post('/mcp', middleware, (req, res) => {
    res.json({ auth: (req as unknown as { auth: unknown }).auth });
  });

  return withListening(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: authorization === undefined ? {} : { Authorization: authorization },
      signal: AbortSignal.timeout(2000),
    });
    return {
      status: res.status,
      challenge: res.headers.get('WWW-Authenticate'),
      // Express's default error handler answers with HTML.
      body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(),
      origin: baseUrl,
    };
  });
}

const reject = async () => undefined;
const metadataUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const resourceUrl = 'https://mcp.example.com/mcp';

describe('mcpAuth', () => {
  test.each([
    ['oversized chunked gzip', 'gzip', true, false, 401],
    ['small gzip', 'gzip', false, false, 401],
    ['mixed-case gzip', 'GZip', false, false, 401],
    ['deflate', 'deflate', false, false, 401],
    ['brotli', 'br', false, false, 401],
    ['ordinary JSON', undefined, false, false, 200],
    ['identity JSON', 'identity', false, false, 200],
    ['mixed-case identity JSON', 'Identity', false, false, 200],
    ['authenticated gzip', 'gzip', false, true, 200],
    ['authenticated oversized chunked gzip', 'gzip', true, true, 200],
  ] as const)(
    'answers a public ping in a %s body before handoff',
    async (_case, encoding, oversized, authenticated, expectedStatus) => {
      const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
      let body: Buffer;
      switch (encoding?.toLowerCase()) {
        case 'gzip':
          body = gzipSync(ping);
          break;
        case 'deflate':
          body = deflateSync(ping);
          break;
        case 'br':
          body = brotliCompressSync(ping);
          break;
        default:
          body = Buffer.from(ping);
      }
      if (oversized) {
        // FCOMMENT can make the encoded body exceed 1 MiB without increasing the decoded JSON size.
        const header = Buffer.from(body.subarray(0, 10));
        header[3] = header[3]! | 0x10;
        body = Buffer.concat([
          header,
          Buffer.alloc(1024 * 1024 + 1, 'a'),
          Buffer.from([0]),
          body.subarray(10),
        ]);
        expect(body.byteLength).toBeGreaterThan(1024 * 1024);
      }
      const authInfo = { token: 't', scopes: [], clientId: 'caller', expiresAt };
      const verifyToken = vi.fn(async () => authInfo);
      const downstream = vi.fn((_req: express.Request, res: express.Response) => {
        res.json({});
      });
      const app = express();
      app.use(express.json());
      app.post('/mcp', mcpAuth({ verifyToken, publicAccess: { methods: true } }), downstream);

      const status = await withListening(
        app,
        (baseUrl) =>
          new Promise<number>((resolve, reject) => {
            const req = httpRequest(
              `${baseUrl}/mcp`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(encoding === undefined ? {} : { 'Content-Encoding': encoding }),
                  ...(authenticated ? { Authorization: 'Bearer t' } : {}),
                  'Transfer-Encoding': 'chunked',
                },
                signal: AbortSignal.timeout(2000),
              },
              (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode!));
                res.on('error', reject);
              },
            );
            req.on('error', reject);
            req.end(body);
          }),
      );

      expect(status).toBe(expectedStatus);
      expect(downstream).toHaveBeenCalledTimes(expectedStatus === 200 ? 1 : 0);
      expect(verifyToken).toHaveBeenCalledTimes(authenticated ? 1 : 0);
      if (expectedStatus === 200) {
        const req = downstream.mock.calls[0]![0] as express.Request & { auth: unknown };
        expect(req.auth).toEqual(authenticated ? expect.objectContaining(authInfo) : undefined);
      }
    },
  );

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

  test.each([[[resourceUrl]], [undefined]])(
    'calls verifyToken with the token and the request instead of Clerk (resourceUrl: %j)',
    async (listed) => {
      const authenticateRequest = vi.mocked(clerkClient.authenticateRequest);
      authenticateRequest.mockReset();
      const verifyToken = vi.fn(async (token: string, req: express.Request) => ({
        token,
        scopes: [],
        clientId: req.path,
        expiresAt,
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
        auth: {
          token: 'my-token',
          scopes: [],
          clientId: '/mcp',
          expiresAt,
          resourceMetadataUrl: metadataUrl,
        },
      });
    },
  );

  test('throws at setup for an invalid resourceUrl', () => {
    expect(() => mcpAuth({ verifyToken: reject, resourceUrl: '/mcp' })).toThrow(
      'Clerk error: mcpAuth resourceUrl must be an absolute http or https URL',
    );
  });

  test('rejects a non-function verifyToken at setup', () => {
    expect(() => mcpAuth({ verifyToken: null } as never)).toThrow(
      'Clerk error: mcpAuth verifyToken must be a function',
    );
  });

  test.each([
    ['missing_token', undefined, undefined],
    ['malformed_token', 'Basic abc', undefined],
    ['invalid_token', 'Bearer bad', undefined],
    ['insufficient_scope', 'Bearer t', { token: 't', scopes: [], clientId: 'c', expiresAt }],
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

  test('logs an McpAuthError with the verifier error as its cause, keeping its 5xx status, instead of passing it to error middleware', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = Object.assign(new Error('network down'), { status: 503 });
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
    app.use(((err, _req, res, _next) => {
      errors.push(err);
      res.status(500).end();
    }) satisfies express.ErrorRequestHandler);

    const res = await withListening(app, async (baseUrl) => {
      const answer = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
      });
      return { status: answer.status, body: await answer.json() };
    });
    const logged = consoleError.mock.calls.map(([error]) => error);
    consoleError.mockRestore();

    expect(res).toEqual({ status: 503, body: { error: 'server_error' } });
    expect(errors).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBeInstanceOf(McpAuthError);
    expect(logged[0]).toMatchObject({ reason: 'verification_failed', cause });
  });

  // Express's default error handler destroys the socket of a sent response, which resets a client still uploading
  test.each([false, true])(
    'answers an McpAuthError for a large unread body (connection close: %s)',
    async (close) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const app = express();
      if (close)
        app.use((_req, res, next) => {
          res.setHeader('Connection', 'close');
          next();
        });
      app.post(
        '/mcp',
        mcpAuth({
          verifyToken: async () => {
            throw new Error('network down');
          },
        }),
      );

      const answers = await withListening(app, async (baseUrl) => {
        const { port } = new URL(baseUrl);
        const results: { status?: number | undefined; body?: string; error?: string }[] = [];
        for (const size of [1_000_000, 2_000_000, 5_000_000]) {
          results.push(
            await new Promise((resolve) => {
              const body = 'x'.repeat(size);
              let responseStarted = false;
              let uploadTimer: ReturnType<typeof setTimeout> | undefined;
              const stopUpload = () => clearTimeout(uploadTimer);
              const req = httpRequest(
                {
                  host: '127.0.0.1',
                  port: Number(port),
                  signal: AbortSignal.timeout(2000),
                  method: 'POST',
                  path: '/mcp',
                  headers: {
                    authorization: 'Bearer t',
                    'content-type': 'application/json',
                    'content-length': String(size),
                  },
                },
                (res) => {
                  responseStarted = true;
                  stopUpload();
                  let text = '';
                  res.on('data', (chunk) => (text += chunk));
                  res.on('error', (error) => resolve({ error: error.message }));
                  res.on('end', () => {
                    // The server can answer without reading the upload. Stop it before the test closes the server.
                    req.destroy();
                    resolve({ status: res.statusCode, body: text });
                  });
                },
              );
              req.on('error', (error: NodeJS.ErrnoException) => {
                stopUpload();
                // A completed early response is authoritative even if the pending upload hits the closed socket.
                if (responseStarted && (error.code === 'EPIPE' || error.code === 'ECONNRESET'))
                  return;
                resolve({ error: error.message });
              });
              req.on('close', stopUpload);
              let offset = 0;
              const upload = () => {
                if (responseStarted || req.destroyed) return;
                if (offset === body.length) {
                  req.end();
                  return;
                }
                const chunk = body.slice(offset, offset + 32_768);
                offset += chunk.length;
                req.write(chunk, (error) => {
                  if (error || responseStarted || req.destroyed) return;
                  uploadTimer = setTimeout(upload, 10);
                });
              };
              req.flushHeaders();
              upload();
            }),
          );
        }
        return results;
      });
      consoleError.mockRestore();

      expect(answers).toEqual(
        Array.from({ length: 3 }, () => ({ status: 500, body: '{"error":"server_error"}' })),
      );
    },
  );

  test('logs the McpAuthError even when the client disconnects before the answer', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let disconnected: () => void = () => undefined;
    const clientGone = new Promise<void>((resolve) => (disconnected = resolve));
    const app = express();
    app.post(
      '/mcp',
      mcpAuth({
        verifyToken: async (_token, req) => {
          await new Promise((resolve) => req.socket.once('close', resolve));
          disconnected();
          throw new Error('network down');
        },
      }),
    );

    await withListening(app, async (baseUrl) => {
      const abort = new AbortController();
      const answer = fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
        signal: abort.signal,
      }).catch(() => undefined);
      setTimeout(() => abort.abort(), 50);
      await clientGone;
      await answer;
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
    });
    const [[logged]] = consoleError.mock.calls as [[unknown]];
    consoleError.mockRestore();

    expect(logged).toBeInstanceOf(McpAuthError);
  });

  test.each([undefined, ['https://mcp.example.com/mcp']])(
    'answers a Host header that does not parse with a 400 (resourceUrl: %j)',
    async (listed) => {
      const verifyToken = vi.fn();
      const response = await sendRawTo(
        mcpAuth({ verifyToken, resourceUrl: listed }),
        'POST /mcp HTTP/1.1\r\nHost: [\r\nAuthorization: Bearer t\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );

      expect(response.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
      expect(verifyToken).not.toHaveBeenCalled();
    },
  );

  test('answers an HTTP/1.0 request without a Host header with a 400 instead of using http://undefined', async () => {
    const verifyToken = vi.fn();
    const response = await sendRawTo(
      mcpAuth({ verifyToken }),
      'POST /mcp HTTP/1.0\r\nAuthorization: Bearer t\r\nContent-Length: 0\r\n\r\n',
    );

    expect(response).toMatch(/^HTTP\/1\.[01] 400 Bad Request/);
    expect(response).not.toContain('undefined');
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test('verifies a token sent with an absolute-form request-target against the listed resourceUrl', async () => {
    const verifyToken = vi.fn(async (token: string) => ({
      token,
      clientId: 'c',
      scopes: [],
      expiresAt,
    }));
    const response = await sendRawTo(
      mcpAuth({ verifyToken, resourceUrl: ['http://mcp.example.com/mcp'] }),
      'POST http://mcp.example.com/mcp HTTP/1.1\r\nHost: mcp.example.com\r\nAuthorization: Bearer t\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(verifyToken).toHaveBeenCalledOnce();
  });

  test.each([
    ['header.example', 421],
    ['target.example', 200],
  ])('selects the absolute-form authority with only %s listed', async (listedHost, status) => {
    const verifyToken = vi.fn(async (token: string) => ({
      token,
      clientId: 'c',
      scopes: [],
      expiresAt,
    }));
    const downstream = vi.fn((_req: express.Request, res: express.Response) => {
      res.json({});
    });
    const response = await sendRawTo(
      mcpAuth({ verifyToken, resourceUrl: [`http://${listedHost}/mcp`] }),
      'POST http://target.example/mcp HTTP/1.1\r\nHost: header.example\r\nAuthorization: Bearer t\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      (app, handler) => app.post('/mcp', handler, downstream),
    );

    expect(response.split('\r\n')[0]).toContain(` ${status} `);
    expect(verifyToken).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    expect(downstream).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  test.each([
    ['http://TARGET.example:8080/mcp?x=1', 'http://target.example:8080/mcp', 'header.example'],
    ['https://target.example/mcp', 'https://target.example/mcp', '['],
    ['http://[::1]:8080/mcp', 'http://[::1]:8080/mcp', 'header.example'],
  ])(
    'uses the complete absolute-form URL %s (resource %s, Host %s)',
    async (target, listed, host) => {
      const verifyToken = vi.fn(async (token: string) => ({
        token,
        clientId: 'c',
        scopes: [],
        expiresAt,
      }));
      const response = await sendRawTo(
        mcpAuth({ verifyToken, resourceUrl: [listed] }),
        `POST ${target} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer t\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        (app, handler) => {
          app.set('trust proxy', true);
          return app.post('/mcp', handler, (_req, res) => {
            res.json({});
          });
        },
      );

      expect(response.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
      expect(verifyToken).toHaveBeenCalledOnce();
    },
  );

  test('ignores forwarded authority and scheme for an absolute-form target with trust proxy', async () => {
    const response = await sendRawTo(
      mcpAuth({ verifyToken: reject }),
      'POST https://target.example/mcp HTTP/1.1\r\nHost: header.example\r\nX-Forwarded-Host: forwarded.example\r\nX-Forwarded-Proto: http\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      (app, handler) => {
        app.set('trust proxy', true);
        return app.post('/mcp', handler);
      },
    );

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized');
    expect(response).toContain(
      'WWW-Authenticate: Bearer resource_metadata="https://target.example/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('accepts an HTTP/1.0 absolute-form target without Host', async () => {
    const response = await sendRawTo(
      mcpAuth({ verifyToken: reject }),
      'POST http://target.example/mcp HTTP/1.0\r\nContent-Length: 0\r\n\r\n',
    );

    expect(response).toMatch(/^HTTP\/1\.[01] 401 Unauthorized/);
    expect(response).toContain(
      'WWW-Authenticate: Bearer resource_metadata="http://target.example/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test.each<[string, number[]]>([
    ['http:/target.example/mcp', [400]],
    ['http:///target.example/mcp', [400]],
    // Node may reject the bad port with 400 before Express can reject it with 404.
    ['http://target.example:bad/mcp', [400, 404]],
    ['http://target.example/mcp#fragment', [400]],
    ['http://user:pass@target.example/mcp', [400]],
    ['http://target.example\\other/mcp', [400]],
    ['ftp://target.example/mcp', [400]],
    ['*', [400]],
  ])(
    'rejects a malformed or unsupported request-target %s before verification',
    async (target, statuses) => {
      const verifyToken = vi.fn();
      const downstream = vi.fn((_req: express.Request, res: express.Response) => {
        res.json({});
      });
      const response = await sendRawTo(
        mcpAuth({ verifyToken, resourceUrl: ['http://header.example/mcp'] }),
        `POST ${target} HTTP/1.1\r\nHost: header.example\r\nAuthorization: Bearer t\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        (app, handler) => app.use(handler, downstream),
      );

      expect(statuses).toContain(Number(response.split(' ')[1]));
      expect(verifyToken).not.toHaveBeenCalled();
      expect(downstream).not.toHaveBeenCalled();
    },
  );

  test('keeps a single resourceUrl authoritative despite a conflicting absolute-form target', async () => {
    const response = await sendRawTo(
      mcpAuth({ verifyToken: reject, resourceUrl: 'https://configured.example/mcp' }),
      'POST http://target.example/mcp HTTP/1.1\r\nHost: header.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized');
    expect(response).toContain(
      'WWW-Authenticate: Bearer resource_metadata="https://configured.example/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('uses the absolute-form authority for the challenge despite a conflicting Host', async () => {
    const response = await sendRawTo(
      mcpAuth({ verifyToken: reject }),
      'POST http://target.example/mcp?x=1 HTTP/1.1\r\nHost: header.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized');
    expect(response).toContain(
      'WWW-Authenticate: Bearer resource_metadata="http://target.example/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('points the challenge for an absolute-form request-target at the metadata for its path', async () => {
    const response = await sendRawTo(
      mcpAuth({ verifyToken: reject }),
      'POST http://mcp.example.com/mcp?x=1 HTTP/1.1\r\nHost: mcp.example.com\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized');
    expect(response).toContain(
      'WWW-Authenticate: Bearer resource_metadata="http://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

describe('protectedResourceMetadataHandler', () => {
  beforeEach(() => {
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', FAKE_PK);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('uses the absolute-form authority for metadata despite a conflicting Host', async () => {
    const response = await sendRawTo(
      protectedResourceMetadataHandler(),
      'GET http://target.example/.well-known/oauth-protected-resource/mcp HTTP/1.1\r\nHost: header.example\r\nConnection: close\r\n\r\n',
      (app, handler) => app.all('/.well-known/oauth-protected-resource/mcp', handler),
    );

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    const metadata = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as {
      resource: string;
    };
    expect(metadata.resource).toBe('http://target.example/mcp');
  });

  test('varies shared caches by the forwarded origin for a list of resourceUrls', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.all(
      '/.well-known/oauth-protected-resource/mcp',
      protectedResourceMetadataHandler({
        resourceUrl: ['https://mcp.example.com/mcp', 'https://other.example.com/mcp'],
      }),
    );

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, {
        headers: { 'X-Forwarded-Host': 'other.example.com', 'X-Forwarded-Proto': 'https' },
      }),
    );

    expect(res.headers.get('vary')).toBe('X-Forwarded-Host, X-Forwarded-Proto');
    expect((await res.json()).resource).toBe('https://other.example.com/mcp');
  });

  test('derives the resource of an absolute-form request-target from its path alone', async () => {
    const response = await sendRawTo(
      protectedResourceMetadataHandler(),
      'GET http://mcp.example.com/.well-known/oauth-protected-resource/mcp HTTP/1.1\r\nHost: mcp.example.com\r\nConnection: close\r\n\r\n',
      (app, handler) => app.all('/.well-known/oauth-protected-resource/mcp', handler),
    );

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    const metadata = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as {
      resource: string;
    };
    expect(metadata.resource).toBe('http://mcp.example.com/mcp');
  });
});

// Sends a raw request to an app that mounts `handler`, by default before a route at /mcp that answers {}
function sendRawTo(
  handler: express.RequestHandler,
  raw: string,
  mount = (app: express.Express, h: express.RequestHandler) =>
    app.post('/mcp', h, (_req, res) => {
      res.json({});
    }),
) {
  const app = express();
  mount(app, handler);
  return withListening(app, (baseUrl) => sendRaw(baseUrl, raw));
}

describe('mcpAuth with Clerk', () => {
  const authenticateRequest = vi.mocked(clerkClient.authenticateRequest);

  beforeEach(() => {
    authenticateRequest.mockReset();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_express');
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', FAKE_PK);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A setup mistake is thrown as it is, not as the cause of an `McpAuthError`, and before any token arrives, as in Hono
  test.each([
    ['CLERK_SECRET_KEY', 'with a token', 'Bearer token-1'],
    ['CLERK_SECRET_KEY', 'without a token', undefined],
    ['CLERK_PUBLISHABLE_KEY', 'with a token', 'Bearer token-1'],
    ['CLERK_PUBLISHABLE_KEY', 'without a token', undefined],
  ])(
    'throws a Clerk error naming %s when it is not set, %s',
    async (name, _case, authorization) => {
      vi.stubEnv(name, '');
      const errors: unknown[] = [];
      const app = express();
      app.post('/mcp', mcpAuth({ resourceUrl }), (_req, res) => {
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

      expect(res.status).toBe(500);
      expect(errors).toHaveLength(1);
      expect(errors[0]).not.toBeInstanceOf(McpAuthError);
      expect((errors[0] as Error).message).toBe(
        `Clerk error: mcpAuth needs the ${name} environment variable or a clerkClient option`,
      );
      expect(authenticateRequest).not.toHaveBeenCalled();
    },
  );

  test('fails loudly instead of hanging when passed to a route without being called', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(mcpAuth as unknown as express.RequestHandler);
    consoleError.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body).toContain('Clerk error: mcpAuth needs a resourceUrl');
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
    const authenticateRequest = vi.fn().mockResolvedValue({
      isAuthenticated: false,
      reason: 'token-invalid',
      message: 'OAuth token not found (code=token-invalid, status=404)',
    });

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
      const res = await withApp(streamableHttpHandler(createServer, Transport), (baseUrl) =>
        fetch(`${baseUrl}/mcp`, {
          method,
          headers: { accept: 'application/json, text/event-stream' },
          signal: AbortSignal.timeout(2000),
        }),
      );

      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
      expect(createServer).not.toHaveBeenCalled();
    },
  );
});

const card = { name: 'com.example/weather', version: '1.2.0', description: 'Forecasts.' };

describe.each([
  [
    'serverCardHandler',
    () => serverCardHandler({ ...card, resourceUrl: 'https://mcp.example.com/mcp' }),
    '/mcp/server-card',
    'application/mcp-server-card+json',
  ],
  [
    'aiCatalogHandler',
    () =>
      aiCatalogHandler({
        entries: [
          {
            identifier: 'urn:air:example.com:mcp:weather',
            url: 'https://mcp.example.com/mcp/server-card',
          },
        ],
      }),
    '/.well-known/ai-catalog.json',
    'application/ai-catalog+json',
  ],
])('%s', (_name, handler, path, mediaType) => {
  test('keeps the headers earlier middleware set, on the document and on a 304', async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader('x-request-id', 'r1');
      next();
    });
    app.all(path, handler());

    const [res, notModified] = await withListening(app, async (baseUrl) => {
      const first = await fetch(`${baseUrl}${path}`);
      const second = await fetch(`${baseUrl}${path}`, {
        headers: { 'if-none-match': first.headers.get('etag')! },
      });
      return [first, second];
    });

    expect(res.headers.get('x-request-id')).toBe('r1');
    expect(res.headers.get('content-type')).toBe(mediaType);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('x-request-id')).toBe('r1');
  });

  test('merges ETag into earlier CORS exposure and keeps no-store on error responses', async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader('access-control-allow-origin', 'https://app.example');
      res.setHeader('access-control-expose-headers', 'WWW-Authenticate');
      res.setHeader('cache-control', 'public, max-age=3600');
      next();
    });
    app.all(path, handler());

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { origin: 'https://app.example' },
      }),
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate, ETag');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test.each([
    ['an existing case-insensitive ETag', 'etag, WWW-Authenticate'],
    ['a wildcard', '*'],
  ])('does not duplicate or narrow %s in CORS exposure', async (_case, exposeHeaders) => {
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader('access-control-expose-headers', exposeHeaders);
      next();
    });
    app.all(path, handler());

    const res = await withListening(app, (baseUrl) => fetch(`${baseUrl}${path}`));

    expect(res.headers.get('access-control-expose-headers')).toBe(exposeHeaders);
  });

  // As protectedResourceMetadataHandler's own CORS headers do, unlike Hono, where a cors() middleware's are kept
  test('replaces an Access-Control-Allow-Origin earlier middleware set with its own', async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader('access-control-allow-origin', 'https://app.example');
      next();
    });
    app.all(path, handler());

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}${path}`, { headers: { origin: 'https://app.example' } }),
    );

    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toBe('ETag');
  });

  test('answers HEAD without a body when mounted with app.get', async () => {
    const app = express();
    app.get(path, handler());

    const res = await withListening(app, (baseUrl) =>
      fetch(`${baseUrl}${path}`, { method: 'HEAD' }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toMatch(/^W\//);
    expect(res.headers.get('content-type')).toBe(mediaType);
  });

  // The handler answers conditional requests itself, so Express's own ETag setting and its `req.fresh`, which treats a
  // request's `Cache-Control: no-cache` as stale, change nothing
  test("sends its own weak ETag and 304 whatever the app's etag setting or the request's Cache-Control", async () => {
    const app = express();
    app.set('etag', 'strong');
    app.all(path, handler());

    const [res, notModified] = await withListening(app, async (baseUrl) => {
      const first = await fetch(`${baseUrl}${path}`);
      const second = await fetch(`${baseUrl}${path}`, {
        headers: { 'if-none-match': first.headers.get('etag')!, 'cache-control': 'no-cache' },
      });
      return [first, second];
    });

    expect(res.headers.get('etag')).toMatch(/^W\/"[!#-~]+"$/);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('etag')).toBe(res.headers.get('etag'));
    expect(await notModified.text()).toBe('');
  });

  // The document is the same for every request, so the request's URL is never needed
  test.each([
    [
      'a Host header that does not parse',
      `GET ${path} HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n`,
    ],
    ['an HTTP/1.0 request without a Host header', `GET ${path} HTTP/1.0\r\n\r\n`],
  ])('serves the document to %s', async (_case, raw) => {
    const app = express();
    app.all(path, handler());

    const response = await withListening(app, (baseUrl) => sendRaw(baseUrl, raw));
    const [head] = response.split('\r\n\r\n');

    expect(head).toMatch(/^HTTP\/1\.[01] 200 OK/);
    expect(head).toMatch(new RegExp(`^content-type: ${mediaType.replace('+', '\\+')}$`, 'im'));
    expect(head).toMatch(/^etag: W\//im);
  });
});

// A list of resourceUrls selects by the target's origin, or by a Host that parses for origin-form targets.
describe('serverCardHandler with a list of resourceUrls', () => {
  test.each([
    ['https://mcp.example.com', 200],
    ['http://header.example', 421],
    ['http://forwarded.example', 421],
  ])('selects the absolute-form origin with only %s listed', async (origin, status) => {
    const app = express();
    app.set('trust proxy', true);
    app.all('/mcp/server-card', serverCardHandler({ ...card, resourceUrl: [`${origin}/mcp`] }));

    const response = await withListening(app, (baseUrl) =>
      sendRaw(
        baseUrl,
        'GET https://mcp.example.com/mcp/server-card HTTP/1.1\r\nHost: header.example\r\nX-Forwarded-Host: forwarded.example\r\nX-Forwarded-Proto: http\r\nConnection: close\r\n\r\n',
      ),
    );
    const [head, body] = response.split('\r\n\r\n');

    expect(head).toContain(` ${status} `);
    if (status === 200) {
      expect(JSON.parse(body).remotes).toEqual([
        { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      ]);
    } else {
      expect(head).toMatch(/^cache-control: no-store$/im);
      expect(JSON.parse(body)).toEqual({ error: 'misdirected_request' });
    }
  });

  test('accepts an HTTP/1.0 absolute-form target without Host', async () => {
    const app = express();
    app.all(
      '/mcp/server-card',
      serverCardHandler({ ...card, resourceUrl: ['https://mcp.example.com/mcp'] }),
    );

    const response = await withListening(app, (baseUrl) =>
      sendRaw(baseUrl, 'GET https://mcp.example.com/mcp/server-card HTTP/1.0\r\n\r\n'),
    );
    const [head, body] = response.split('\r\n\r\n');

    expect(head).toMatch(/^HTTP\/1\.[01] 200 OK/);
    expect(JSON.parse(body).remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    ]);
  });

  test.each([
    [
      'a Host header that does not parse',
      'GET /mcp/server-card HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
    ],
    ['an HTTP/1.0 request without a Host header', 'GET /mcp/server-card HTTP/1.0\r\n\r\n'],
  ])('answers %s with a JSON 400 that is never stored', async (_case, raw) => {
    const app = express();
    app.all(
      '/mcp/server-card',
      serverCardHandler({ ...card, resourceUrl: ['https://mcp.example.com/mcp'] }),
    );

    const response = await withListening(app, (baseUrl) => sendRaw(baseUrl, raw));
    const [head, body] = response.split('\r\n\r\n');

    expect(head).toMatch(/^HTTP\/1\.[01] 400 Bad Request/);
    expect(head).toMatch(/^access-control-allow-origin: \*$/im);
    expect(head).toMatch(/^cache-control: no-store$/im);
    expect(head).not.toMatch(/^etag:/im);
    expect(body).toBe('{"error":"invalid_request"}');
  });
});

// For origin-form targets, `X-Forwarded-*` headers count only under Express's `trust proxy`.
describe('serverCardHandler behind a proxy', () => {
  const listed = { ...card, resourceUrl: ['https://mcp.example.com/mcp'] };

  async function fetchCard(trustProxy: boolean, forwarded: Record<string, string>) {
    const app = express();
    if (trustProxy) app.set('trust proxy', true);
    app.all('/mcp/server-card', serverCardHandler(listed));
    return withListening(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/mcp/server-card`, { headers: forwarded });
      return { status: res.status, vary: res.headers.get('vary'), body: await res.json() };
    });
  }

  const forwarded = { 'x-forwarded-host': 'mcp.example.com', 'x-forwarded-proto': 'https' };

  test('selects the listed URL from the forwarded origin under trust proxy', async () => {
    const res = await fetchCard(true, forwarded);

    expect(res.status).toBe(200);
    expect(res.vary).toBe('X-Forwarded-Host, X-Forwarded-Proto');
    expect(res.body.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    ]);
  });

  test.each([
    ['forwarded headers without trust proxy', false, forwarded],
    [
      'a forwarded port the list lacks',
      true,
      { ...forwarded, 'x-forwarded-host': 'mcp.example.com:8443' },
    ],
    ['a forwarded scheme the list lacks', true, { ...forwarded, 'x-forwarded-proto': 'http' }],
    [
      'only an Origin header naming the listed origin',
      false,
      { origin: 'https://mcp.example.com' },
    ],
  ])('answers %s with a 421', async (_case, trustProxy, headers) => {
    const res = await fetchCard(trustProxy, headers);

    expect(res).toEqual({
      status: 421,
      vary: 'X-Forwarded-Host, X-Forwarded-Proto',
      body: { error: 'misdirected_request' },
    });
  });
});
