// End to end: the MCP SDK v1 client against a Hono server that uses `mcpAuth`, discoverable by default and with
// `publicAccess`, on MCP SDK 2.x.
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  createMcpHandler,
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
import { mcpAppViewResource } from '../tools';
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
const VIEW_URIS = ['ui://docs/viewer.html', 'ui://docs/editor.html'] as const;
const VIEW_HTML =
  '<!DOCTYPE html><html><head><meta name="color-scheme" content="light dark"></head></html>';
// Built at module scope, as the README advises, so their URIs are recorded before the first request
const VIEWS = VIEW_URIS.map((uri) => mcpAppViewResource({ name: uri, uri, html: VIEW_HTML }));
// A ui:// resource registered without mcpAppViewResource, which views does not open
const PLAIN_UI_URI = 'ui://docs/plain.html';

// `streamableHttpHandler` serves the protocol revisions before 2026-07-28, and MCP SDK 2's `createMcpHandler` serves
// 2026-07-28 as well
type Serve = 'streamableHttpHandler' | 'createMcpHandler';

function startServer(
  readBody: ReadBody | undefined = undefined,
  options: ServerOptions = PUBLIC_TOOLS,
  serve: Serve = 'streamableHttpHandler',
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
    // MCP App view templates, which hosts may prefetch before the user signs in
    for (const view of VIEWS) server.registerResource(...view);
    server.registerResource('plain', PLAIN_UI_URI, {}, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html', text: VIEW_HTML }],
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
    serve === 'streamableHttpHandler'
      ? streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport)
      : (c) => {
          const authInfo: AuthInfo | undefined = c.get('mcpAuth');
          return createMcpHandler(createServer).fetch(c.req.raw, { ...(authInfo && { authInfo }) });
        },
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

// A POST of one JSON-RPC request without a token, as a client on protocol revision 2026-07-28 sends it, with the
// `_meta` envelope that revision requires of every request
function postRequest(
  fetchImpl: ReturnType<typeof startServer>['fetchImpl'],
  method: string,
  params: Record<string, unknown> = {},
  // The `Mcp-Name` header that revision requires of a request that names a tool, resource, or prompt
  name: string | undefined = undefined,
) {
  return fetchImpl(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(name !== undefined && { 'mcp-name': name }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '0.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

// The one JSON-RPC message in a response, sent as JSON or as the only event of a stream
async function responseMessage(res: Response): Promise<unknown> {
  const text = await res.text();
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(data!.slice('data: '.length));
  }
  return JSON.parse(text);
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
    const { fetchImpl } = startServer(undefined, PUBLIC_TOOLS, 'createMcpHandler');
    const post = (notifications: Record<string, unknown>) =>
      postRequest(fetchImpl, 'subscriptions/listen', { notifications });

    const listening = await post({ toolsListChanged: true });
    expect(listening.status).toBe(200);
    expect(listening.headers.get('content-type')).toBe('text/event-stream');
    await listening.body?.cancel();

    const subscribed = await post({ resourceSubscriptions: ['docs://private'] });
    expect(subscribed.status).toBe(401);
    expect(subscribed.headers.get('www-authenticate')).toMatch(/^Bearer /);
  });

  test('challenges the cancellation of a public tool call, so the client starts authorization', async () => {
    const { client, redirects, toolCalls, answers } = await connect();
    const abort = new AbortController();

    const call = client.callTool({ name: 'slow_search', arguments: {} }, undefined, {
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(toolCalls).toHaveBeenCalledWith('slow_search'));
    const before = answers.length;
    abort.abort();
    await expect(call).rejects.toThrow();

    // The client tells the server with a notifications/cancelled POST. It is not checked against the caller, so
    // it needs a token even here.
    await vi.waitFor(() => expect(answers.length).toBeGreaterThan(before));
    expect(answers.slice(before).filter((answer) => answer.startsWith('POST'))).toEqual([
      'POST 401',
    ]);
    // The SDK client answers that challenge by starting authorization
    await vi.waitFor(() => expect(redirects).toHaveLength(1));
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
    expect(resources.map((resource) => resource.uri)).toEqual([
      'docs://guide',
      ...VIEW_URIS,
      PLAIN_UI_URI,
    ]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      'docs://pages/{slug}',
    ]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['summarize']);

    expect(redirects).toHaveLength(0);
    expect(answers.filter((answer) => answer.endsWith(' 401'))).toEqual([]);
  });

  // Protocol revision 2026-07-28 replaces `initialize` with this request. With no `discoverable` or `publicAccess`
  // option, discovery is open by default.
  test('answers the server/discover of a client without a token on a server with neither option', async () => {
    const { fetchImpl } = startServer(undefined, {}, 'createMcpHandler');

    const res = await postRequest(fetchImpl, 'server/discover');
    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await responseMessage(res)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        supportedVersions: expect.arrayContaining(['2026-07-28']),
        capabilities: { tools: {}, resources: {}, prompts: {} },
      },
    });
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

describe('a server with a publicAccess.methods list', () => {
  const handshakeOnly: ServerOptions = {
    publicAccess: { methods: ['initialize', 'server/discover'], tools: ['search_docs'] },
  };

  test('lets a client without a token connect and call a named tool, but challenges a list it leaves out', async () => {
    const { fetchImpl, toolCalls, answers } = startServer(undefined, handshakeOnly);
    const { client, connected, redirects } = connectOAuthClient(MCP_URL, fetchImpl, undefined);
    await connected;
    try {
      expect(textOf(await client.callTool({ name: 'search_docs', arguments: {} }))).toBe('results');
      expect(toolCalls.mock.calls).toEqual([['search_docs']]);
      expect(redirects).toHaveLength(0);
      await vi.waitFor(() => expect(answers).toContain('GET 405'));

      await expect(client.listTools()).rejects.toBeInstanceOf(UnauthorizedError);
      expect(redirects).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  test('opens only the listed methods, and answers a GET without a token with the 401 when no handshake is listed', async () => {
    const { fetchImpl } = startServer(undefined, { publicAccess: { methods: ['ping'] } });

    const ping = await postRequest(fetchImpl, 'ping');
    await ping.body?.cancel();
    expect(ping.status).not.toBe(401);
    for (const method of ['server/discover', 'tools/list']) {
      const res = await postRequest(fetchImpl, method);
      expect(res.status, method).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata=/);
    }
    const get = await fetchImpl(MCP_URL, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    expect(get.status).toBe(401);
  });
});

describe('MCP App views on a server with publicAccess', () => {
  // A resources/read without a token, as a client on protocol revision 2026-07-28 sends it
  async function read(options: ServerOptions, uri: string) {
    const { fetchImpl } = startServer(undefined, options, 'createMcpHandler');
    return postRequest(fetchImpl, 'resources/read', { uri }, uri);
  }

  test('lets a client without a token read a ui:// view template on a discoverable server', async () => {
    const { client, redirects, answers } = await connect();
    try {
      const { contents } = await client.readResource({ uri: VIEW_URIS[0] });
      expect(contents).toEqual([
        { uri: VIEW_URIS[0], mimeType: 'text/html;profile=mcp-app', text: VIEW_HTML },
      ]);
      expect(redirects).toHaveLength(0);
      expect(answers.filter((answer) => answer.endsWith(' 401'))).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test.each([
    { name: 'publicAccess left out', options: {} },
    { name: 'discoverable: true', options: { discoverable: true } },
    {
      name: 'a methods list and views: true',
      options: { publicAccess: { methods: ['initialize', 'resources/list'], views: true } },
    },
  ] satisfies { name: string; options: ServerOptions }[])(
    'opens views with $name',
    async ({ options }) => {
      const res = await read(options, VIEW_URIS[1]);
      expect(res.status).toBe(200);
      expect(await responseMessage(res)).toMatchObject({
        result: { contents: [{ uri: VIEW_URIS[1] }] },
      });
    },
  );

  test.each(['docs://guide', PLAIN_UI_URI, 'ui://docs/unregistered.html'])(
    'keeps %s, which mcpAppViewResource did not build, behind the challenge',
    async (uri) => {
      const res = await read(PUBLIC_TOOLS, uri);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata=/);
    },
  );

  test.each([
    { name: 'views: false', options: { publicAccess: { views: false } } },
    // A methods list chooses exactly what is open, so views stays off unless it is set too
    {
      name: 'a methods list that opens resources/list',
      options: { publicAccess: { methods: ['initialize', 'resources/list'] } },
    },
  ] satisfies { name: string; options: ServerOptions }[])(
    'challenges a view read without a token with $name',
    async ({ options }) => {
      const res = await read(options, VIEW_URIS[0]);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata=/);
    },
  );

  test('with views: false, opens only the views publicAccess.resources names', async () => {
    const options: ServerOptions = { publicAccess: { views: false, resources: [VIEW_URIS[1]] } };
    expect((await read(options, VIEW_URIS[0])).status).toBe(401);
    const named = await read(options, VIEW_URIS[1]);
    expect(named.status).toBe(200);
    await named.body?.cancel();
  });

  // Protocol revision 2026-07-28: subscriptions/listen replaces resources/subscribe, so a view views opens can be
  // subscribed to without a token too, and a resource it does not open still closes the request
  test('admits a subscriptions/listen to an open view, but not one that also names a closed resource', async () => {
    const { fetchImpl } = startServer(undefined, PUBLIC_TOOLS, 'createMcpHandler');
    const listen = (resourceSubscriptions: string[]) =>
      postRequest(fetchImpl, 'subscriptions/listen', { notifications: { resourceSubscriptions } });

    const listening = await listen([VIEW_URIS[0]]);
    expect(listening.status).toBe(200);
    await listening.body?.cancel();

    for (const closed of [[VIEW_URIS[0], 'docs://guide'], [PLAIN_UI_URI]]) {
      const res = await listen(closed);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
    }
  });

  // A view built inside the server factory is recorded only once the factory runs, after auth checked the request
  test('warns once when a view is first built after a request was checked, and opens it from then on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const late = 'ui://docs/late.html';
      expect((await read(PUBLIC_TOOLS, late)).status).toBe(401);

      mcpAppViewResource({ name: late, uri: late, html: VIEW_HTML });
      mcpAppViewResource({ name: late, uri: late, html: VIEW_HTML });
      expect(warn.mock.calls).toEqual([
        [
          'Clerk warning: mcpAppViewResource built ui://docs/late.html after mcpAuth checked a request, so publicAccess.views did not open it for the requests before. Build views once at module scope, not inside the server factory.',
        ],
      ]);
      const opened = await read(PUBLIC_TOOLS, late);
      expect(opened.status).toBe(200);
      await opened.body?.cancel();
    } finally {
      warn.mockRestore();
    }
  });

  test('a client with a token reads a view with views: false', async () => {
    const { fetchImpl } = startServer(undefined, { publicAccess: { views: false } });
    const { client, connected } = connectOAuthClient(MCP_URL, fetchImpl, 'token_full');
    await connected;
    try {
      const { contents } = await client.readResource({ uri: VIEW_URIS[0] });
      expect(contents[0]).toMatchObject({ uri: VIEW_URIS[0] });
    } finally {
      await client.close();
    }
  });
});
