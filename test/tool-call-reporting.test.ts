import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer as McpServerV2, createMcpHandler } from '@modelcontextprotocol/server';
import express from 'express';
import { Hono } from 'hono';
import { createMcpHandler as createVercelMcpHandler } from 'mcp-handler';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as expressAdapter from '../express';
import * as honoAdapter from '../hono';
import { ERROR_CODE_META_KEY } from '../mcp-tool';
import * as nextAdapter from '../next';
import { clerkInstrumentServer } from '../server';
import {
  beginToolCallContext,
  normalizeIpAddress,
  resolveReporting,
  toolCallOutcome,
} from '../tool-call-reporting';
import golden from './fixtures/mcp-events.golden.json';
import { connectOAuthClient, withListening } from './mcp-harness';

const RESOURCE_URL = 'https://mcp.example.com/mcp';
const USER_ID = 'user_2xhFjEI5X2qWRvtV13BzSj8H6Dk';
const TOKEN_ID = 'oat_2xhFjEI5X2qWRvtV13BzSj8H6Dk';
const CLIENT_ID = 'Ab12Cd34Ef56Gh78';
const USER_AGENT = 'claude-code/2.1.0';
const SECRET_KEY = 'sk_test_reporting';

const clerkClient = {
  authenticateRequest: async () => ({
    isAuthenticated: true as const,
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: 'oauth_token',
      id: TOKEN_ID,
      subject: USER_ID,
      userId: USER_ID,
      clientId: CLIENT_ID,
      scopes: ['profile'],
      getToken: async () => 'token',
    }),
  }),
};

type ReportBody = { events: Record<string, unknown>[]; sdk: { name: string; version: string } };

function reportSink(status = 202) {
  const bodies: ReportBody[] = [];
  const requests: { url: string; authorization: string | null }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    bodies.push(JSON.parse(String(init?.body)) as ReportBody);
    return Response.json({ object: 'mcp_event_ingestion', accepted: 1 }, { status });
  });
  return { fetch, bodies, requests, calls: () => bodies.flatMap((body) => body.events) };
}

const typesOf = (value: object) =>
  Object.fromEntries(Object.entries(value).map(([key, field]) => [key, typeof field]));

const REQUIRED_TOOL_CALL_FIELDS = ['type', 'occurred_at', 'tool_name', 'status', 'duration_ms'];

/**
 * Checks each batch against the golden batch that the bapi-proxy suite in clerk/cloudflare-workers posts to
 * `POST /v1/mcp_events`: every field an event sends is in the golden event of its type and status, with the same
 * type, and the required fields are there. `exact` also requires every golden field to be sent.
 */
function expectGoldenShape(bodies: ReportBody[], { exact = false } = {}) {
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(Object.keys(body).sort()).toEqual(Object.keys(golden).sort());
    expect(typesOf(body.sdk)).toEqual(typesOf(golden.sdk));
    for (const event of body.events) {
      const match = golden.events.find(
        (candidate) => candidate.type === event.type && candidate.status === event.status,
      );
      expect(
        match,
        `a golden ${String(event.type)} event with status ${String(event.status)}`,
      ).toBeDefined();
      if (exact) expect(typesOf(event)).toEqual(typesOf(match!));
      else expect(typesOf(match!)).toMatchObject(typesOf(event));
      expect(Object.keys(event)).toEqual(expect.arrayContaining(REQUIRED_TOOL_CALL_FIELDS));
    }
  }
}

function registerTools(
  server: Pick<McpServer, 'registerTool'> | Pick<McpServerV2, 'registerTool'>,
) {
  const register = server.registerTool.bind(server) as McpServer['registerTool'];
  register('ping', { description: 'Replies with pong' }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  register('fail', { description: 'Fails with a code' }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'The upstream timed out' }],
    _meta: { [ERROR_CODE_META_KEY]: 'upstream_timeout' },
  }));
}

function sdkV2Handler(instrument = true) {
  return createMcpHandler(() => {
    const server = new McpServerV2({ name: 'acme-mcp', version: '1.0.0' });
    if (instrument) clerkInstrumentServer(server);
    registerTools(server);
    return server;
  });
}

function withUserAgent(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('user-agent', USER_AGENT);
  return { ...init, headers };
}

async function callTools(
  fetchApp: (input: string | URL, init?: RequestInit) => Promise<Response>,
  mcpUrl = RESOURCE_URL,
) {
  const { client, connected } = connectOAuthClient(new URL(mcpUrl), fetchApp, 'token');
  await connected;
  expect(await client.callTool({ name: 'ping' })).toMatchObject({ content: [{ text: 'pong' }] });
  expect(await client.callTool({ name: 'fail' })).toMatchObject({ isError: true });
  await client.close();
}

function honoApp(
  handler: honoAdapter.McpHandler,
  options: Partial<honoAdapter.McpAuthOptions> = {},
) {
  const app = new Hono();
  app.all(
    '/mcp',
    honoAdapter.clerkInstrumentHandler(handler, {
      resourceUrl: RESOURCE_URL,
      clerkClient,
      ...options,
    } as honoAdapter.McpAuthOptions),
  );
  const waits: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
    passThroughOnException: () => {},
    props: {},
  };
  const bindings = { incoming: { socket: { remoteAddress: '::ffff:203.0.113.7' } } };
  return {
    fetch: (input: string | URL, init?: RequestInit) =>
      Promise.resolve(app.fetch(new Request(input, withUserAgent(init)), bindings, executionCtx)),
    settled: () => Promise.all(waits),
  };
}

const expectedCalls = (overrides: Record<string, unknown> = {}) => [
  {
    type: 'tool_call',
    tool_name: 'ping',
    server_name: 'acme-mcp',
    status: 'success',
    duration_ms: expect.any(Number),
    occurred_at: expect.any(Number),
    user_id: USER_ID,
    client_id: CLIENT_ID,
    oauth_access_token_id: TOKEN_ID,
    user_agent: USER_AGENT,
    ...overrides,
  },
  {
    type: 'tool_call',
    tool_name: 'fail',
    server_name: 'acme-mcp',
    status: 'error',
    error_code: 'upstream_timeout',
    duration_ms: expect.any(Number),
    occurred_at: expect.any(Number),
    user_id: USER_ID,
    client_id: CLIENT_ID,
    oauth_access_token_id: TOKEN_ID,
    user_agent: USER_AGENT,
    ...overrides,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('clerkInstrumentHandler from @clerk/mcp-tools/hono', () => {
  test('reports each tool call to the Backend API once the response is over', async () => {
    vi.stubEnv('CLERK_SECRET_KEY', SECRET_KEY);
    const sink = reportSink();
    const app = honoApp(sdkV2Handler(), { reporting: { fetch: sink.fetch } });

    await callTools(app.fetch);
    await app.settled();

    expect(sink.calls()).toEqual(expectedCalls({ ip_address: '203.0.113.7' }));
    expectGoldenShape(sink.bodies, { exact: true });
    expect(sink.requests[0]).toEqual({
      url: 'https://api.clerk.com/v1/mcp_events',
      authorization: `Bearer ${SECRET_KEY}`,
    });
    expect(sink.bodies[0]!.sdk).toEqual({ name: '@clerk/mcp-tools', version: expect.any(String) });
  });

  test('reports a tool call on protocol revision 2026-07-28', async () => {
    const sink = reportSink();
    const app = honoApp(sdkV2Handler(), {
      reporting: { fetch: sink.fetch, secretKey: SECRET_KEY },
    });

    const response = await app.fetch(RESOURCE_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'ping',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'ping',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'client', version: '0.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('pong');
    await app.settled();

    expect(sink.calls()).toEqual([expectedCalls({ ip_address: '203.0.113.7' })[0]]);
  });

  test('leaves out each field and tool its options turn off', async () => {
    const sink = reportSink();
    const app = honoApp(sdkV2Handler(), {
      reporting: {
        fetch: sink.fetch,
        secretKey: SECRET_KEY,
        ipAddress: false,
        userAgent: false,
        identity: false,
        tools: (name) => name !== 'fail',
        serverName: 'acme-production',
      },
    });

    await callTools(app.fetch);
    await app.settled();

    expect(sink.calls()).toEqual([
      {
        type: 'tool_call',
        tool_name: 'ping',
        server_name: 'acme-production',
        status: 'success',
        duration_ms: expect.any(Number),
        occurred_at: expect.any(Number),
      },
    ]);
  });

  test('reports the address an ipAddress function returns, when it is one', async () => {
    const sink = reportSink();
    const addresses = ['2001:db8::1', 'not-an-address'];
    const app = honoApp(sdkV2Handler(), {
      reporting: {
        fetch: sink.fetch,
        secretKey: SECRET_KEY,
        ipAddress: () => addresses.shift(),
      },
    });

    for (let i = 0; i < 2; i++) await (await app.fetch(RESOURCE_URL, toolCallInit('ping'))).text();
    await app.settled();

    expect(sink.calls().map((call) => call.ip_address)).toEqual(['2001:db8::1', undefined]);
  });

  test('reports nothing when reporting is off', async () => {
    const sink = reportSink();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = honoApp(sdkV2Handler());

    await callTools(app.fetch);
    await app.settled();

    expect(sink.fetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('warns once when the server was not passed to clerkInstrumentServer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = reportSink();
    const app = honoApp(sdkV2Handler(false), {
      reporting: { fetch: sink.fetch, secretKey: SECRET_KEY },
    });

    await callTools(app.fetch);
    await app.settled();

    expect(sink.fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /^Clerk warning: clerkInstrumentHandler reports tool calls only from servers passed to clerkInstrumentServer/,
    );
  });

  test('still answers a request without a token that publicAccess lets through', async () => {
    const sink = reportSink();
    const app = honoApp(sdkV2Handler(), {
      publicAccess: { tools: ['ping'] },
      reporting: { fetch: sink.fetch, secretKey: SECRET_KEY },
    });

    const { authorization: _, ...headers } = toolCallInit('ping').headers as Record<string, string>;
    const response = await app.fetch(RESOURCE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
      }),
    });
    expect(await response.text()).toContain('pong');
    await app.settled();
    expect(sink.fetch).not.toHaveBeenCalled();
  });
});

function toolCallInit(name: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    }),
  };
}

describe('clerkInstrumentHandler from @clerk/mcp-tools/express', () => {
  test('reports the tool calls of an MCP SDK 2.x handler, served through @modelcontextprotocol/node', async () => {
    const sink = reportSink();
    const app = express();
    app.use(express.json());
    app.all(
      '/mcp',
      expressAdapter.clerkInstrumentHandler(sdkV2Handler(), {
        resourceUrl: RESOURCE_URL,
        clerkClient,
        reporting: { fetch: sink.fetch, secretKey: SECRET_KEY },
      }),
    );

    await withListening(app, (baseUrl) =>
      callTools((input, init) => fetch(input, withUserAgent(init)), `${baseUrl}/mcp`),
    );

    await vi.waitFor(() => expect(sink.calls()).toHaveLength(2), { timeout: 3000 });
    expect(sink.calls()).toEqual(expectedCalls({ ip_address: '127.0.0.1' }));
    expectGoldenShape(sink.bodies);
  });

  test('reports the tool calls of an Express handler serving an MCP SDK 1.x transport', async () => {
    const sink = reportSink();
    const app = express();
    app.use(express.json());
    app.all(
      '/mcp',
      expressAdapter.clerkInstrumentHandler(
        async (req, res) => {
          const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
          clerkInstrumentServer(server);
          registerTools(server);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => void transport.close());
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        },
        {
          resourceUrl: RESOURCE_URL,
          clerkClient,
          reporting: { fetch: sink.fetch, secretKey: SECRET_KEY },
        },
      ),
    );

    await withListening(app, (baseUrl) =>
      callTools((input, init) => fetch(input, withUserAgent(init)), `${baseUrl}/mcp`),
    );

    await vi.waitFor(() => expect(sink.calls()).toHaveLength(2), { timeout: 3000 });
    expect(sink.calls()).toEqual(expectedCalls({ ip_address: '127.0.0.1' }));
    expectGoldenShape(sink.bodies);
  });

  test('mcpAuth refuses reporting, which it cannot see', () => {
    expect(() =>
      expressAdapter.mcpAuth({
        resourceUrl: RESOURCE_URL,
        reporting: true,
      } as expressAdapter.McpAuthOptions),
    ).toThrow(
      'Clerk error: mcpAuth cannot report tool calls. Serve the MCP route with clerkInstrumentHandler(handler, options)',
    );
    expect(() =>
      expressAdapter.mcpAuth({
        resourceUrl: RESOURCE_URL,
        reporting: false,
      } as expressAdapter.McpAuthOptions),
    ).not.toThrow();
  });

  test('protectedResourceMetadataHandler takes the same options', () => {
    expect(() =>
      expressAdapter.protectedResourceMetadataHandler({
        resourceUrl: RESOURCE_URL,
        reporting: true,
      }),
    ).not.toThrow();
  });

  test('warns once when an instrumented server answers a tool call mcpAuth authenticated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = express();
    app.use(express.json());
    app.all(
      '/mcp',
      expressAdapter.mcpAuth({ resourceUrl: RESOURCE_URL, clerkClient }),
      expressAdapter.streamableHttpHandler(() => {
        const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
        clerkInstrumentServer(server);
        registerTools(server);
        return server;
      }, StreamableHTTPServerTransport),
    );

    await withListening(app, (baseUrl) => callTools(fetch, `${baseUrl}/mcp`));

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(
        /^Clerk warning: clerkInstrumentServer only sees tool calls that clerkInstrumentHandler authenticated/,
      ),
    ]);
  });
});

describe('clerkInstrumentHandler from @clerk/mcp-tools/next', () => {
  test('reports the tool calls of a server mcp-handler creates', async () => {
    const sink = reportSink();
    const handler = createVercelMcpHandler(
      (server) => {
        clerkInstrumentServer(server);
        registerTools(server);
      },
      { serverInfo: { name: 'acme-mcp', version: '1.0.0' } },
    );
    const route = nextAdapter.clerkInstrumentHandler(handler, {
      resourceUrl: RESOURCE_URL,
      clerkClient,
      reporting: { fetch: sink.fetch, secretKey: SECRET_KEY },
    });

    await callTools((input, init) => route(new Request(input, withUserAgent(init))));

    await vi.waitFor(() => expect(sink.calls()).toHaveLength(2), { timeout: 3000 });
    expect(sink.calls()).toEqual(expectedCalls());
    expectGoldenShape(sink.bodies);
  });

  test('reports the address Vercel sets on x-real-ip', async () => {
    vi.stubEnv('VERCEL', '1');
    const sink = reportSink();
    const route = nextAdapter.clerkInstrumentHandler(sdkV2Handler(), {
      resourceUrl: RESOURCE_URL,
      clerkClient,
      reporting: { fetch: sink.fetch, secretKey: SECRET_KEY },
    });
    const init = toolCallInit('ping');

    const response = await route(
      new Request(RESOURCE_URL, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'x-real-ip': '198.51.100.4' },
      }),
    );
    await response.text();

    await vi.waitFor(() => expect(sink.calls()).toHaveLength(1), { timeout: 3000 });
    expect(sink.calls()[0]!.ip_address).toBe('198.51.100.4');
  });

  test('warns once and serves the request when no secret key is set', async () => {
    vi.stubEnv('CLERK_SECRET_KEY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = reportSink();
    const route = nextAdapter.clerkInstrumentHandler(sdkV2Handler(), {
      resourceUrl: RESOURCE_URL,
      clerkClient,
      reporting: { fetch: sink.fetch },
    });

    const response = await route(new Request(RESOURCE_URL, toolCallInit('ping')));
    expect(await response.text()).toContain('pong');

    expect(sink.fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Clerk warning: clerkInstrumentHandler needs the CLERK_SECRET_KEY environment variable or reporting.secretKey to report tool calls, so they are not reported',
    );
  });

  test('withClerkMcpAuth refuses reporting', () => {
    expect(() =>
      nextAdapter.withClerkMcpAuth(sdkV2Handler().fetch, {
        resourceUrl: RESOURCE_URL,
        reporting: true,
      } as nextAdapter.McpAuthOptions),
    ).toThrow('Clerk error: withClerkMcpAuth cannot report tool calls');
  });
});

describe('reporting options', () => {
  test('defaults every field on', () => {
    expect(resolveReporting('clerkInstrumentHandler', true)).toEqual({
      ipAddress: true,
      userAgent: true,
      identity: true,
      tools: undefined,
      serverName: undefined,
      secretKey: undefined,
      apiUrl: undefined,
      fetch: undefined,
    });
    expect(resolveReporting('clerkInstrumentHandler', false)).toBeUndefined();
    expect(resolveReporting('clerkInstrumentHandler', undefined)).toBeUndefined();
  });

  test.each([
    ['an unknown key', { ipAdress: false }, 'reporting has no ipAdress option'],
    ['a string', 'yes', 'reporting must be true, false, or an options object'],
    ['a non-boolean flag', { userAgent: 'no' }, 'reporting.userAgent must be a boolean'],
    ['a tools list', { tools: ['ping'] }, 'reporting.tools must be a function'],
    ['a server name the API refuses', { serverName: 'acme\nmcp' }, 'reporting.serverName must be'],
    ['an HTTP API URL', { apiUrl: 'http://api.clerk.com' }, 'reporting.apiUrl must use HTTPS'],
  ])('refuses %s when the handler is created', (_, value, message) => {
    expect(() => resolveReporting('clerkInstrumentHandler', value)).toThrow(
      `Clerk error: clerkInstrumentHandler ${message}`,
    );
  });

  test('clerkInstrumentHandler checks reporting when it is created', () => {
    expect(() =>
      honoAdapter.clerkInstrumentHandler(sdkV2Handler(), {
        resourceUrl: RESOURCE_URL,
        reporting: { bogus: true } as never,
      }),
    ).toThrow('Clerk error: clerkInstrumentHandler reporting has no bogus option');
  });
});

describe('tool call reports', () => {
  test('are sent in batches of at most 100', async () => {
    const sink = reportSink();
    const context = beginToolCallContext({
      caller: 'clerkInstrumentHandler',
      reporting: resolveReporting('clerkInstrumentHandler', {
        fetch: sink.fetch,
        secretKey: SECRET_KEY,
      }),
      authInfo: { token: 'token', clientId: 'client', scopes: [] },
      request: undefined,
      defaultIpAddress: () => undefined,
      userAgent: () => undefined,
      env: { secretKey: undefined, apiUrl: undefined },
    })!;

    for (let i = 0; i < 150; i++) context.startToolCall('ping', 'acme-mcp')!({ status: 'success' });
    await context.flush();

    expect(sink.bodies.map((body) => body.events.length)).toEqual([100, 50]);
  });

  test('keep at most 1000 waiting while sends hang, dropping the oldest and warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = reportSink();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      await released;
      return sink.fetch(input, init);
    });
    const context = beginToolCallContext({
      caller: 'clerkInstrumentHandler',
      reporting: resolveReporting('clerkInstrumentHandler', { fetch, secretKey: SECRET_KEY }),
      authInfo: { token: 'token', clientId: 'client', scopes: [] },
      request: undefined,
      defaultIpAddress: () => undefined,
      userAgent: () => undefined,
      env: { secretKey: undefined, apiUrl: undefined },
    })!;

    for (let i = 0; i < 2500; i++)
      context.startToolCall(`tool_${i}`, 'acme-mcp')!({ status: 'success' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(10));
    release();
    await context.flush();
    await vi.waitFor(() => expect(sink.calls()).toHaveLength(2000));

    const sent = new Set(sink.calls().map((call) => call.tool_name));
    expect(sent.has('tool_999')).toBe(true);
    expect(sent.has('tool_1000')).toBe(false);
    expect(sent.has('tool_1499')).toBe(false);
    expect(sent.has('tool_1500')).toBe(true);
    expect(sent.has('tool_2499')).toBe(true);
    expect(warn.mock.calls).toEqual([
      [
        'Clerk warning: clerkInstrumentHandler dropped the oldest MCP events waiting to be sent, because 1000 were already waiting',
      ],
    ]);
  });

  test('warn once when the Backend API refuses them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = reportSink(401);
    const context = beginToolCallContext({
      caller: 'clerkInstrumentHandler',
      reporting: resolveReporting('clerkInstrumentHandler', {
        fetch: sink.fetch,
        secretKey: SECRET_KEY,
      }),
      authInfo: { token: 'token', clientId: 'client', scopes: [] },
      request: undefined,
      defaultIpAddress: () => undefined,
      userAgent: () => undefined,
      env: { secretKey: undefined, apiUrl: undefined },
    })!;

    for (let i = 0; i < 2; i++) {
      context.startToolCall('ping', undefined)!({ status: 'success' });
      await context.flush();
    }

    expect(warn.mock.calls).toEqual([
      [
        'Clerk warning: clerkInstrumentHandler could not report 1 MCP events to Clerk, which answered with status 401. Check the secret key',
      ],
    ]);
  });

  test('take the outcome of each kind of tools/call response', () => {
    expect(toolCallOutcome({ result: { content: [] } })).toEqual({ status: 'success' });
    expect(
      toolCallOutcome({
        result: { isError: true, _meta: { [ERROR_CODE_META_KEY]: 'rate_limited' } },
      }),
    ).toEqual({ status: 'error', errorCode: 'rate_limited' });
    expect(toolCallOutcome({ result: { isError: true, content: [] } })).toEqual({
      status: 'error',
      errorCode: undefined,
    });
    expect(toolCallOutcome({ error: { code: -32602, message: 'Unknown tool' } })).toEqual({
      status: 'error',
      errorCode: 'jsonrpc:-32602',
    });
  });

  test.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['2001:db8::1', '2001:db8::1'],
    [' 198.51.100.4 ', '198.51.100.4'],
    ['198.51.100.4, 10.0.0.1', undefined],
    ['localhost', undefined],
    [undefined, undefined],
  ])('report %j as the IP address %j', (input, expected) => {
    expect(normalizeIpAddress(input)).toBe(expected);
  });
});
