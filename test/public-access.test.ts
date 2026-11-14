// End to end: the MCP SDK v1 client against a Hono server that uses `mcpAuth` with `publicAccess`, on MCP SDK 2.x.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { type Context, Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

import { mcpAuth, requireAdditionalScopes, streamableHttpHandler } from '../hono';
import type { AuthInfo } from '../mcp-types';
import { textOf } from './mcp-harness';

const ORIGIN = 'https://mcp.example.com';
const MCP_URL = new URL('/mcp', ORIGIN);

const TOKENS: Record<string, string[]> = {
  token_profile_only: ['profile'],
  token_full: ['profile', 'email'],
};

function verifyToken(token: string): AuthInfo | undefined {
  const scopes = TOKENS[token];
  return scopes && { token, clientId: 'client_1', scopes, extra: { userId: 'user_1' } };
}

type ReadBody = (context: Context) => Promise<unknown>;

function startServer(readBody: ReadBody | undefined = undefined) {
  const toolCalls = vi.fn();
  // Every answer the MCP endpoint gave, as `<method> <status>`
  const answers: string[] = [];

  const createServer = () => {
    const server = new McpServer({ name: 'docs-server', version: '0.0.0' });
    server.registerTool('search_docs', { description: 'Searches the public docs' }, async () => {
      toolCalls('search_docs');
      return { content: [{ type: 'text' as const, text: 'results' }] };
    });
    // Never answers, so a test can cancel the call while it is in flight
    server.registerTool('slow_search', { description: 'Searches slowly' }, async () => {
      toolCalls('slow_search');
      return new Promise<never>(() => {});
    });
    server.registerTool(
      'get_primary_email',
      {
        description: "Returns the signed-in user's email",
        scopeChallenge: requireAdditionalScopes('email'),
      },
      async (ctx) => {
        toolCalls('get_primary_email');
        const userId = String(ctx.http?.authInfo?.extra?.userId);
        return { content: [{ type: 'text' as const, text: `email of ${userId}` }] };
      },
    );
    return server;
  };

  const app = new Hono();
  if (readBody) {
    app.use('/mcp', async (c, next) => {
      if (c.req.method === 'POST') await readBody(c);
      await next();
    });
  }
  app.all(
    '/mcp',
    mcpAuth({
      verifyToken,
      resourceUrl: MCP_URL.href,
      challengeScopes: ['profile', 'email'],
      publicAccess: { methods: true, tools: ['search_docs', 'slow_search'] },
    }),
    streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
  );

  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path === '/.well-known/oauth-protected-resource/mcp') {
      return Response.json({
        resource: MCP_URL.href,
        authorization_servers: [ORIGIN],
        scopes_supported: ['profile', 'email'],
      });
    }
    if (path === '/.well-known/oauth-authorization-server') {
      return Response.json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (path !== '/mcp') return new Response('Not Found', { status: 404 });
    const res = await app.fetch(req);
    answers.push(`${req.method} ${res.status}`);
    return res;
  };

  return { fetchImpl, toolCalls, answers };
}

// A client that holds `token`, or none. Authorization ends at the redirect, which it records.
async function connect(token?: string, readBody: ReadBody | undefined = undefined) {
  const { fetchImpl, toolCalls, answers } = startServer(readBody);
  const redirects: URL[] = [];
  const authProvider: OAuthClientProvider = {
    redirectUrl: 'http://localhost/callback',
    clientMetadata: { redirect_uris: ['http://localhost/callback'], client_name: 'e2e' },
    clientInformation: () => ({ client_id: 'client_1' }),
    tokens: () => (token ? { access_token: token, token_type: 'Bearer' } : undefined),
    saveTokens: () => {},
    redirectToAuthorization: (url) => {
      redirects.push(url);
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => 'verifier',
  };
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(MCP_URL, { authProvider, fetch: fetchImpl }),
  );
  return { client, redirects, toolCalls, answers };
}

describe('a server with publicAccess', () => {
  test.each([
    { name: 'untouched', readBody: undefined },
    { name: 'cached JSON', readBody: (c: Context) => c.req.json() },
    { name: 'cached text', readBody: (c: Context) => c.req.text() },
    { name: 'cloned raw', readBody: (c: Context) => c.req.raw.clone().json() },
  ])(
    'body handoff preserves $name requests through auth and the real transport',
    async ({ readBody }) => {
      const { client, redirects, toolCalls, answers } = await connect(undefined, readBody);
      try {
        expect(textOf(await client.callTool({ name: 'search_docs', arguments: {} }))).toBe(
          'results',
        );
        expect(redirects).toHaveLength(0);
        expect(answers).not.toContain('POST 400');

        await expect(
          client.callTool({ name: 'get_primary_email', arguments: {} }),
        ).rejects.toBeInstanceOf(UnauthorizedError);
        expect(answers).toContain('POST 401');
        expect(redirects).toHaveLength(1);
        expect(toolCalls.mock.calls).toEqual([['search_docs']]);
      } finally {
        await client.close();
      }
    },
  );

  test.each([
    { name: 'JSON', readBody: (c: Context) => c.req.json() },
    { name: 'text', readBody: (c: Context) => c.req.text() },
  ])('body handoff preserves verified auth with cached $name', async ({ readBody }) => {
    const { client, toolCalls } = await connect('token_full', readBody);
    try {
      expect(textOf(await client.callTool({ name: 'get_primary_email', arguments: {} }))).toBe(
        'email of user_1',
      );
      expect(toolCalls.mock.calls).toEqual([['get_primary_email']]);
    } finally {
      await client.close();
    }
  });

  test('lets a client without a token connect, list tools, and call a public tool, without starting authorization', async () => {
    const { client, redirects, toolCalls, answers } = await connect();

    const { tools } = await client.listTools();
    // The list is open, so it names the protected tool as well
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_docs',
      'slow_search',
      'get_primary_email',
    ]);

    const result = await client.callTool({ name: 'search_docs', arguments: {} });
    expect(textOf(result)).toBe('results');
    expect(toolCalls).toHaveBeenCalledWith('search_docs');

    expect(redirects).toHaveLength(0);
    expect(answers.filter((answer) => answer.endsWith(' 401'))).toEqual([]);
  });

  test('answers the stream a client opens after connecting with a 405, not a challenge', async () => {
    const { redirects, answers } = await connect();

    // The client opens the stream without waiting for it, so give it a turn
    await vi.waitFor(() => expect(answers).toContain('GET 405'));
    expect(redirects).toHaveLength(0);
  });

  // Protocol revision 2026-07-28 replaces that GET stream with this POST
  test('admits the subscriptions/listen a client opens after connecting, but not one for a closed resource', async () => {
    const { fetchImpl } = startServer();
    const post = (notifications: Record<string, unknown>) =>
      fetchImpl(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'subscriptions/listen',
          params: { notifications },
        }),
      });

    // It reaches the transport, which answers this bare request itself; only a challenge would start authorization
    const listening = await post({ toolsListChanged: true });
    await listening.body?.cancel();
    expect(listening.status).not.toBe(401);
    expect(listening.headers.get('www-authenticate')).toBeNull();

    const subscribed = await post({ resourceSubscriptions: ['docs://private'] });
    expect(subscribed.status).toBe(401);
    expect(subscribed.headers.get('www-authenticate')).toMatch(/^Bearer /);
  });

  test('does not start authorization when the client cancels a public tool call', async () => {
    const { client, redirects, toolCalls, answers } = await connect();
    const abort = new AbortController();

    const call = client.callTool({ name: 'slow_search', arguments: {} }, undefined, {
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(toolCalls).toHaveBeenCalledWith('slow_search'));
    const before = answers.length;
    abort.abort();
    await expect(call).rejects.toThrow();

    // The client tells the server with a notifications/cancelled POST, which must not be challenged
    await vi.waitFor(() => expect(answers.length).toBeGreaterThan(before));
    expect(answers.slice(before).filter((answer) => answer.startsWith('POST'))).toEqual([
      'POST 202',
    ]);
    expect(redirects).toHaveLength(0);
  });

  test('starts authorization when the client reaches a protected tool', async () => {
    const { client, redirects, toolCalls } = await connect();

    await expect(
      client.callTool({ name: 'get_primary_email', arguments: {} }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect(redirects).toHaveLength(1);
    expect(redirects[0]!.origin + redirects[0]!.pathname).toBe(`${ORIGIN}/authorize`);
    // The 401 challenge's `scope`, so one sign-in covers the protected tools
    expect(redirects[0]!.searchParams.get('scope')).toBe('profile email');
    expect(redirects[0]!.searchParams.get('resource')).toBe(MCP_URL.href);
    expect(toolCalls).not.toHaveBeenCalled();
  });

  test('steps up a token that lacks the scope of a protected tool', async () => {
    const { client, redirects, toolCalls, answers } = await connect('token_profile_only');

    await expect(
      client.callTool({ name: 'get_primary_email', arguments: {} }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect(answers).toContain('POST 403');
    expect(redirects).toHaveLength(1);
    expect(redirects[0]!.searchParams.get('scope')).toBe('profile email');
    expect(toolCalls).not.toHaveBeenCalled();
  });

  test('runs a protected tool for a token with its scope', async () => {
    const { client, redirects } = await connect('token_full');

    const result = await client.callTool({ name: 'get_primary_email', arguments: {} });

    expect(textOf(result)).toBe('email of user_1');
    expect(redirects).toHaveLength(0);
  });
});
