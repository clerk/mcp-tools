// End to end: the MCP SDK v1 client against a Hono server that uses `mcpAuth`, discoverable by default and with
// `publicAccess`, on MCP SDK 2.x.
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  McpServer,
  ResourceTemplate,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { type Context, Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

import {
  type McpAuthOptions,
  mcpAuth,
  requireAdditionalScopes,
  streamableHttpHandler,
} from '../hono';
import type { AuthInfo } from '../mcp-types';
import { connectOAuthClient, expiresAt, oauthMetadata, textOf } from './mcp-harness';

const ORIGIN = 'https://mcp.example.com';
const MCP_URL = new URL('/mcp', ORIGIN);

const TOKENS: Record<string, string[]> = {
  token_profile_only: ['profile'],
  token_full: ['profile', 'email'],
};

function verifyToken(token: string): AuthInfo | undefined {
  const scopes = TOKENS[token];
  return (
    scopes && {
      token,
      clientId: 'client_1',
      scopes,
      expiresAt,
      extra: { userId: 'user_1' },
    }
  );
}

type ReadBody = (context: Context) => Promise<unknown>;

// The options besides the verifier and the URLs: by default, the server is discoverable and names two public tools
type ServerOptions = Pick<McpAuthOptions, 'discoverable' | 'publicAccess'>;
const PUBLIC_TOOLS: ServerOptions = { publicAccess: { tools: ['search_docs', 'slow_search'] } };

function startServer(
  readBody: ReadBody | undefined = undefined,
  options: ServerOptions = PUBLIC_TOOLS,
) {
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
    server.registerResource('guide', 'docs://guide', { description: 'The guide' }, async (uri) => ({
      contents: [{ uri: uri.href, text: 'guide' }],
    }));
    server.registerResource(
      'page',
      new ResourceTemplate('docs://pages/{slug}', { list: undefined }),
      { description: 'A docs page' },
      async (uri) => ({ contents: [{ uri: uri.href, text: 'page' }] }),
    );
    server.registerPrompt('summarize', { description: 'Summarizes a page' }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'Summarize' } }],
    }));
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
      ...options,
    } as McpAuthOptions),
    streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
  );

  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    const metadata = oauthMetadata(ORIGIN, path, ['profile', 'email']);
    if (metadata) return metadata;
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
  const { client, connected, redirects } = connectOAuthClient(MCP_URL, fetchImpl, token);
  await connected;
  return { client, redirects, toolCalls, answers };
}

// A POST of one JSON-RPC request without a token, as a client on protocol revision 2026-07-28 sends it
function postRequest(
  fetchImpl: ReturnType<typeof startServer>['fetchImpl'],
  method: string,
  params: Record<string, unknown> = {},
) {
  return fetchImpl(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('a server with publicAccess, discoverable by default', () => {
  test.each([
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

  test('lets a client without a token list resources, resource templates, and prompts', async () => {
    const { client, redirects, answers } = await connect();

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(['docs://guide']);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      'docs://pages/{slug}',
    ]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['summarize']);

    expect(redirects).toHaveLength(0);
    expect(answers.filter((answer) => answer.endsWith(' 401'))).toEqual([]);
  });

  // Protocol revision 2026-07-28 replaces `initialize` with this request
  test('answers the server/discover of a client without a token, not a challenge', async () => {
    const { fetchImpl } = startServer();

    const res = await postRequest(fetchImpl, 'server/discover');
    await res.body?.cancel();
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  test('challenges a call to a tool it does not name, which a token then reaches', async () => {
    const { fetchImpl } = startServer();
    const res = await postRequest(fetchImpl, 'tools/call', {
      name: 'get_primary_email',
      arguments: {},
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata=/);

    const { client } = await connect('token_full');
    try {
      expect(textOf(await client.callTool({ name: 'get_primary_email', arguments: {} }))).toBe(
        'email of user_1',
      );
    } finally {
      await client.close();
    }
  });
});

describe('a server with discoverable: false', () => {
  test('challenges a client without a token when it connects', async () => {
    const { fetchImpl, answers } = startServer(undefined, { discoverable: false });
    const { client, connected, redirects } = connectOAuthClient(MCP_URL, fetchImpl, undefined);

    await expect(connected).rejects.toBeInstanceOf(UnauthorizedError);
    expect(answers[0]).toBe('POST 401');
    expect(redirects).toHaveLength(1);
    await client.close();
  });

  test('challenges the server/discover of a client without a token', async () => {
    const { fetchImpl } = startServer(undefined, { discoverable: false });

    const res = await postRequest(fetchImpl, 'server/discover');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata=/);
  });

  test('lets a client with a token connect and list tools', async () => {
    const { fetchImpl } = startServer(undefined, { discoverable: false });
    const { client, connected } = connectOAuthClient(MCP_URL, fetchImpl, 'token_full');
    await connected;
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('get_primary_email');
    } finally {
      await client.close();
    }
  });
});
