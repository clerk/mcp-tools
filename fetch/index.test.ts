// Drives the fetch entry the way a Cloudflare Worker calls it, `fetch(request, env, ctx)`, with hand-written requests
// and the real `@clerk/backend` verifier. With `CLERK_JWT_KEY` in the Worker env, Clerk checks a JWT access token
// locally, so these tests need no network.
import { createSign, generateKeyPairSync } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { AuthInfo } from '../mcp-types';
import { mcpAuth } from '../hono/index';
import { FAKE_PK } from '../test/mcp-harness';
import {
  type McpAuthFailure,
  createClerkMcpWorker,
  isClerkAuthInfo,
  withClerkMcpAuth,
} from './index';

const resourceUrl = 'https://mcp.example.com/mcp';
const RESOURCE_METADATA_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// The Worker env a Cloudflare Worker passes to `fetch`, with a binding beside the Clerk keys
const workerEnv = {
  CLERK_SECRET_KEY: 'sk_test_fetch_entry',
  CLERK_PUBLISHABLE_KEY: FAKE_PK,
  CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  GREETING: 'hello from a binding',
};
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

function accessToken(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = [
    encode({ alg: 'RS256', typ: 'at+jwt', kid: 'ins_test' }),
    encode({
      iss: 'https://clerk.example.com',
      sub: 'user_123',
      client_id: 'client_123',
      scope: 'profile email',
      jti: 'oat_123',
      aud: resourceUrl,
      iat: now - 10,
      nbf: now - 10,
      exp: now + 300,
      ...claims,
    }),
  ].join('.');
  const signature = createSign('RSA-SHA256').update(signed).sign(privateKey, 'base64url');
  return `${signed}.${signature}`;
}

// A tool call, which `discoverable` does not open, so a request without a token gets the challenge
const toolCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} },
});

function mcpRequest(token?: string, url = resourceUrl) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: toolCall,
  });
}

// A handler that records what it was called with, and answers with the auth info it received
function recordingHandler() {
  return vi.fn(async (_request: Request, { authInfo }: { authInfo: AuthInfo | undefined }) =>
    Response.json({ authInfo: authInfo ?? null }),
  );
}

beforeEach(() => {
  // The fetch entry never reads `process.env`: these keys would let a fallback pass
  vi.stubEnv('CLERK_SECRET_KEY', '');
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('withClerkMcpAuth from @clerk/mcp-tools/fetch', () => {
  test('answers a request without a token with a 401 challenge naming the resource metadata URL', async () => {
    const handler = recordingHandler();
    const authedHandler = withClerkMcpAuth(handler, { resourceUrl });

    const res = await authedHandler(mcpRequest(), workerEnv, ctx);

    expect(res.status).toBe(401);
    // RFC 6750 section 3: no error code without a token. RFC 9728 section 5.1: resource_metadata names the metadata.
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  test('lists requiredScopes in the challenge scope', async () => {
    const authedHandler = withClerkMcpAuth(recordingHandler(), {
      resourceUrl,
      requiredScopes: ['profile', 'email'],
    });

    const res = await authedHandler(mcpRequest(), workerEnv, ctx);

    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="profile email"`,
    );
  });

  test('serves the protected resource metadata the challenge points to, from the Worker env', async () => {
    const handler = recordingHandler();
    const authedHandler = withClerkMcpAuth(handler, {
      resourceUrl,
      requiredScopes: ['profile'],
    });

    const res = await authedHandler(new Request(RESOURCE_METADATA_URL), workerEnv, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // RFC 9728 section 3.3: `resource` is the URL the metadata URL was derived from
    expect(await res.json()).toMatchObject({
      resource: resourceUrl,
      authorization_servers: ['https://clerk.example.com'],
      scopes_supported: ['profile'],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test('answers a CORS preflight to the metadata route', async () => {
    const authedHandler = withClerkMcpAuth(recordingHandler(), { resourceUrl });

    const res = await authedHandler(
      new Request(RESOURCE_METADATA_URL, { method: 'OPTIONS' }),
      workerEnv,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('throws naming CLERK_PUBLISHABLE_KEY when the Worker env has none for the metadata', async () => {
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', FAKE_PK);
    const authedHandler = withClerkMcpAuth(recordingHandler(), { resourceUrl });

    await expect(
      authedHandler(new Request(RESOURCE_METADATA_URL), { CLERK_SECRET_KEY: 'sk_test' }, ctx),
    ).rejects.toThrow('CLERK_PUBLISHABLE_KEY environment variable is required');
  });

  test('rejects a token issued for another resource with an invalid_token challenge', async () => {
    const handler = recordingHandler();
    const failures: McpAuthFailure[] = [];
    const authedHandler = withClerkMcpAuth(handler, {
      resourceUrl,
      onAuthFailure: (failure) => {
        failures.push(failure);
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await authedHandler(
      mcpRequest(accessToken({ aud: 'https://other.example.com/mcp' })),
      workerEnv,
      ctx,
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}", error="invalid_token"`,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(failures).toMatchObject([{ reason: 'invalid_token' }]);
  });

  test('calls the handler with the verified Clerk auth info, the Worker env, and the execution context', async () => {
    const handler = recordingHandler();
    const authedHandler = withClerkMcpAuth(handler, { resourceUrl });
    const token = accessToken();
    const request = mcpRequest(token);

    const res = await authedHandler(request, workerEnv, ctx);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const [received, context] = handler.mock.calls[0]!;
    expect(received).toBe(request);
    expect(context).toMatchObject({ env: workerEnv, ctx });
    expect(isClerkAuthInfo(context.authInfo)).toBe(true);
    expect(context.authInfo).toMatchObject({
      token,
      clientId: 'client_123',
      scopes: ['profile', 'email'],
      extra: { userId: 'user_123' },
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });
    // The handler can still read the body
    expect(await received.json()).toMatchObject({ method: 'tools/call' });
  });

  // The README's composition, driven with a hand-written 2026-07-28 tools/call rather than an SDK client
  test('lets a tool behind createMcpHandler from MCP SDK 2.x read the verified Clerk user', async () => {
    const mcpHandler = createMcpHandler(() => {
      const server = new McpServer({ name: 'worker', version: '1.0.0' });
      server.registerTool(
        'whoami',
        { description: 'Returns the Clerk user ID' },
        async (toolCtx) => {
          const authInfo = toolCtx.http?.authInfo;
          const text = isClerkAuthInfo(authInfo) ? authInfo.extra.userId : 'not signed in';
          return { content: [{ type: 'text' as const, text }] };
        },
      );
      return server;
    });
    const authedHandler = withClerkMcpAuth(
      (request, { authInfo }) => mcpHandler.fetch(request, { ...(authInfo && { authInfo }) }),
      { resourceUrl },
    );

    const res = await authedHandler(
      new Request(resourceUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${accessToken()}`,
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'whoami',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'whoami',
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'raw-client', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
      workerEnv,
      ctx,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // Sent as JSON, or as the only event of a stream
    const message = JSON.parse(text.startsWith('{') ? text : /^data: (.*)$/m.exec(text)![1]!);
    expect(message).toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: 'user_123' }] },
    });
  });

  test('gives the handler the same auth info the Hono adapter gives its route', async () => {
    const token = accessToken();
    const handler = recordingHandler();
    const fetchRes = await withClerkMcpAuth(handler, { resourceUrl })(
      mcpRequest(token),
      workerEnv,
      ctx,
    );
    vi.stubEnv('CLERK_SECRET_KEY', workerEnv.CLERK_SECRET_KEY);
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', workerEnv.CLERK_PUBLISHABLE_KEY);
    vi.stubEnv('CLERK_JWT_KEY', workerEnv.CLERK_JWT_KEY);
    const app = new Hono();
    app.post('/mcp', mcpAuth({ resourceUrl }), (c) => c.json({ authInfo: c.get('mcpAuth') }));

    const honoRes = await app.request(mcpRequest(token));

    expect(fetchRes.status).toBe(200);
    expect(honoRes.status).toBe(200);
    expect(await fetchRes.json()).toEqual(await honoRes.json());
  });

  test.each([
    ['a Worker env without Clerk keys', { GREETING: 'hi' }],
    ['no Worker env', undefined],
  ])(
    'reads the Clerk keys only from the Worker env, never process.env, given %s',
    async (_name, env) => {
      vi.stubEnv('CLERK_SECRET_KEY', workerEnv.CLERK_SECRET_KEY);
      vi.stubEnv('CLERK_PUBLISHABLE_KEY', workerEnv.CLERK_PUBLISHABLE_KEY);
      const authedHandler = withClerkMcpAuth(recordingHandler(), { resourceUrl });

      await expect(authedHandler(mcpRequest(accessToken()), env as never, ctx)).rejects.toThrow(
        'Clerk error: withClerkMcpAuth from @clerk/mcp-tools/fetch needs the CLERK_SECRET_KEY variable in the Worker env or a clerkClient option',
      );
    },
  );

  test('uses a clerkClient option before the Worker env', async () => {
    const authenticateRequest = vi.fn(async () => ({
      isAuthenticated: true,
      toAuth: () => ({
        isAuthenticated: true,
        tokenType: 'oauth_token',
        id: 'oat_1',
        subject: 'user-1',
        getToken: async () => 'token',
        clientId: 'client-1',
        scopes: [],
        userId: 'user-1',
      }),
    }));
    const handler = recordingHandler();
    const authedHandler = withClerkMcpAuth(handler, {
      resourceUrl,
      clerkClient: { authenticateRequest } as never,
    });

    const res = await authedHandler(mcpRequest('token-1'), {}, ctx);

    expect(res.status).toBe(200);
    // Clerk is asked for an OAuth token whose audience is the resource URL
    expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      acceptsToken: 'oauth_token',
      audience: resourceUrl,
    });
    expect(handler.mock.calls[0]![1].authInfo).toMatchObject({ extra: { userId: 'user-1' } });
  });

  test('passes the token, request, Worker env, and context to verifyToken', async () => {
    const verifyToken = vi.fn(async (token: string) => ({
      token,
      clientId: 'client-1',
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }));
    const handler = recordingHandler();
    const request = mcpRequest('token-1');

    const res = await withClerkMcpAuth(handler, { verifyToken })(request, workerEnv, ctx);

    expect(res.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith('token-1', { request, env: workerEnv, ctx });
    expect(handler.mock.calls[0]![1]).toMatchObject({
      authInfo: { token: 'token-1', clientId: 'client-1' },
      env: workerEnv,
      ctx,
    });
  });

  test('answers a verifier that throws with a JSON 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const authedHandler = withClerkMcpAuth(recordingHandler(), {
      verifyToken: async () => {
        throw new Error('database down');
      },
    });

    const res = await authedHandler(mcpRequest('token-1'), workerEnv, ctx);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
  });

  test('throws at setup without a handler, or without a resourceUrl or verifyToken', () => {
    expect(() => withClerkMcpAuth(undefined as never, { resourceUrl })).toThrow(
      'Clerk error: withClerkMcpAuth from @clerk/mcp-tools/fetch takes the handler first',
    );
    expect(() => withClerkMcpAuth(recordingHandler(), {} as never)).toThrow(
      'Clerk error: withClerkMcpAuth from @clerk/mcp-tools/fetch needs a resourceUrl',
    );
  });
});

// A 2026-07-28 request, as a client on that revision sends it: the method in a header and the `_meta` envelope
function modernRequest(
  token: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
) {
  return new Request(resourceUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof params.name === 'string' && { 'mcp-name': params.name }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'raw-client', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

// The one JSON-RPC message in a response, sent as JSON or as the only event of a stream
async function rpcMessage(res: Response) {
  const text = await res.text();
  return JSON.parse(text.startsWith('{') ? text : /^data: (.*)$/m.exec(text)![1]!);
}

// A server whose `whoami` tool answers with the Clerk user and a binding of the Worker env it was built with
function greetingServer({
  authInfo,
  env,
}: {
  authInfo: AuthInfo | undefined;
  env: typeof workerEnv;
}) {
  const server = new McpServer({ name: 'worker', version: '1.0.0' });
  server.registerTool('whoami', { description: 'Returns the Clerk user ID' }, async () => {
    const user = isClerkAuthInfo(authInfo) ? authInfo.extra.userId : 'not signed in';
    return { content: [{ type: 'text' as const, text: `${user}: ${env.GREETING}` }] };
  });
  return server;
}

describe('createClerkMcpWorker from @clerk/mcp-tools/fetch', () => {
  test('answers a request without a token with the same 401 challenge as withClerkMcpAuth', async () => {
    const options = { resourceUrl, requiredScopes: ['profile', 'email'] };
    const server = vi.fn(greetingServer);
    const worker = createClerkMcpWorker({ ...options, server });
    const authedHandler = withClerkMcpAuth(recordingHandler(), options);

    const [res, wrapperRes] = await Promise.all([
      worker.fetch(mcpRequest(), workerEnv, ctx),
      authedHandler(mcpRequest(), workerEnv, ctx),
    ]);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="profile email"`,
    );
    expect({
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: await res.text(),
    }).toEqual({
      status: wrapperRes.status,
      headers: Object.fromEntries(wrapperRes.headers),
      body: await wrapperRes.text(),
    });
    expect(server).not.toHaveBeenCalled();
  });

  test('serves the protected resource metadata the challenge points to', async () => {
    const worker = createClerkMcpWorker({ resourceUrl, server: greetingServer });

    const res = await worker.fetch(new Request(RESOURCE_METADATA_URL), workerEnv, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: resourceUrl,
      authorization_servers: ['https://clerk.example.com'],
    });
  });

  test('rejects a token issued for another resource with an invalid_token challenge', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = vi.fn(greetingServer);
    const worker = createClerkMcpWorker({ resourceUrl, server });

    const res = await worker.fetch(
      modernRequest(accessToken({ aud: 'https://other.example.com/mcp' }), 'tools/call', {
        name: 'whoami',
        arguments: {},
      }),
      workerEnv,
      ctx,
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}", error="invalid_token"`,
    );
    expect(server).not.toHaveBeenCalled();
  });

  test('answers a 2026-07-28 server/discover with a status below 400', async () => {
    const worker = createClerkMcpWorker({ resourceUrl, server: greetingServer });

    const res = await worker.fetch(modernRequest(accessToken(), 'server/discover'), workerEnv, ctx);

    expect(res.status).toBeLessThan(400);
    expect(await rpcMessage(res)).toMatchObject({
      id: 1,
      result: { supportedVersions: expect.arrayContaining(['2026-07-28']) },
    });
  });

  test("calls the server factory for each request with the verified auth info and that request's Worker env", async () => {
    const server = vi.fn(greetingServer);
    const worker = createClerkMcpWorker({ resourceUrl, server });
    const token = accessToken();
    const otherEnv = { ...workerEnv, GREETING: 'hello from another binding' };
    const call = { name: 'whoami', arguments: {} };

    const first = await worker.fetch(modernRequest(token, 'tools/call', call), workerEnv, ctx);
    const second = await worker.fetch(modernRequest(token, 'tools/call', call), otherEnv, ctx);

    expect(await rpcMessage(first)).toMatchObject({
      result: { content: [{ type: 'text', text: 'user_123: hello from a binding' }] },
    });
    expect(await rpcMessage(second)).toMatchObject({
      result: { content: [{ type: 'text', text: 'user_123: hello from another binding' }] },
    });
    expect(server).toHaveBeenCalledTimes(2);
    expect(server.mock.calls.map(([context]) => context.env)).toEqual([workerEnv, otherEnv]);
    for (const [context] of server.mock.calls) {
      expect(isClerkAuthInfo(context.authInfo)).toBe(true);
      expect(context.authInfo).toMatchObject({
        token,
        clientId: 'client_123',
        scopes: ['profile', 'email'],
        extra: { userId: 'user_123' },
      });
    }
  });

  test('names createClerkMcpWorker and the Worker env when a Clerk key is missing', async () => {
    const worker = createClerkMcpWorker({ resourceUrl, server: greetingServer });

    await expect(
      worker.fetch(
        modernRequest(accessToken(), 'server/discover'),
        { GREETING: 'hi' } as never,
        ctx,
      ),
    ).rejects.toThrow(
      'Clerk error: createClerkMcpWorker from @clerk/mcp-tools/fetch needs the CLERK_SECRET_KEY variable in the Worker env or a clerkClient option',
    );
  });

  test('does not depend on the SDK handing the factory the same Request object it was given', async () => {
    // `createMcpHandler` documents `authInfo` as passed through to the factory, and `requestInfo` only as the request
    // being served: an SDK that clones or wraps the request must still reach the right Worker env and auth info
    vi.doMock('@modelcontextprotocol/server', async (importOriginal) => {
      const sdk = await importOriginal<typeof import('@modelcontextprotocol/server')>();
      return {
        ...sdk,
        createMcpHandler: ((factory, handlerOptions) =>
          sdk.createMcpHandler(
            (context) =>
              factory({
                ...context,
                requestInfo:
                  context.requestInfo &&
                  new Request(context.requestInfo.url, { headers: context.requestInfo.headers }),
              }),
            handlerOptions,
          )) satisfies typeof sdk.createMcpHandler,
      };
    });
    try {
      const server = vi.fn(greetingServer);
      const worker = createClerkMcpWorker({ resourceUrl, server });

      const res = await worker.fetch(
        modernRequest(accessToken(), 'tools/call', { name: 'whoami', arguments: {} }),
        workerEnv,
        ctx,
      );

      expect(await rpcMessage(res)).toMatchObject({
        result: { content: [{ type: 'text', text: 'user_123: hello from a binding' }] },
      });
      expect(server).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('@modelcontextprotocol/server');
    }
  });

  test('throws at setup without a server factory, or without a resourceUrl or verifyToken', () => {
    expect(() => createClerkMcpWorker({ resourceUrl } as never)).toThrow(
      'Clerk error: createClerkMcpWorker from @clerk/mcp-tools/fetch needs a server factory',
    );
    expect(() => createClerkMcpWorker({ server: greetingServer } as never)).toThrow(
      'Clerk error: createClerkMcpWorker from @clerk/mcp-tools/fetch needs a resourceUrl',
    );
  });
});
