import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer as McpServerV2, createMcpHandler } from '@modelcontextprotocol/server';
import express from 'express';
import { Hono } from 'hono';
import { createMcpHandler as createVercelMcpHandler } from 'mcp-handler';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';
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

const REQUIRED_FIELDS: Record<string, string[]> = {
  tool_call: ['type', 'occurred_at', 'tool_name', 'status', 'duration_ms'],
  auth_failure: ['type', 'occurred_at', 'reason', 'http_status'],
};

/**
 * Checks each batch against the golden batch that the bapi-proxy suite in clerk/cloudflare-workers posts to
 * `POST /v1/mcp_events`: every field an event sends is in a golden event of its type (and, for a tool call, its
 * status), with the same type, and the required fields are there. `exact` requires a golden event with exactly the
 * event's fields.
 */
function expectGoldenShape(bodies: ReportBody[], { exact = false } = {}) {
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(Object.keys(body).sort()).toEqual(Object.keys(golden).sort());
    expect(typesOf(body.sdk)).toEqual(typesOf(golden.sdk));
    for (const event of body.events) {
      const keys = Object.keys(event);
      const match = (golden.events as Record<string, unknown>[]).find(
        (candidate) =>
          candidate.type === event.type &&
          (event.type !== 'tool_call' || candidate.status === event.status) &&
          (exact
            ? Object.keys(candidate).sort().join() === [...keys].sort().join()
            : keys.every((key) => key in candidate)),
      );
      expect(match, `a golden event with the fields of ${JSON.stringify(event)}`).toBeDefined();
      expect(typesOf(match!)).toMatchObject(typesOf(event));
      expect(keys).toEqual(
        expect.arrayContaining(REQUIRED_FIELDS[String(event.type)] ?? ['unknown type']),
      );
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
    handler_ms: expect.any(Number),
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
    handler_ms: expect.any(Number),
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
        handler_ms: expect.any(Number),
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

const THROWN_TEXT = 'connection to db.internal refused for hunter2';
const RETURNED_TEXT = 'order 4411 belongs to another customer';
const FAILING_TOOLS = ['crash', 'crash_with_string', 'reject'];

type FailingToolServer = Pick<McpServer, 'registerTool'> | Pick<McpServerV2, 'registerTool'>;

function registerFailingTools(server: FailingToolServer) {
  const register = server.registerTool.bind(server) as McpServer['registerTool'];
  register('crash', { description: 'Throws an error' }, async () => {
    throw new TypeError(THROWN_TEXT);
  });
  register('crash_with_string', { description: 'Throws a string' }, async () => {
    throw THROWN_TEXT;
  });
  register('reject', { description: 'Returns an error' }, async () => ({
    isError: true,
    content: [{ type: 'text', text: RETURNED_TEXT }],
  }));
}

function sdkV1ExpressApp(setup: (server: McpServer) => void, sink: ReturnType<typeof reportSink>) {
  const app = express();
  app.use(express.json());
  app.all(
    '/mcp',
    expressAdapter.clerkInstrumentHandler(
      async (req, res) => {
        const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
        setup(server);
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
  return app;
}

async function callFailingTools(
  fetchApp: (input: string | URL, init?: RequestInit) => Promise<Response>,
  mcpUrl = RESOURCE_URL,
) {
  const { client, connected } = connectOAuthClient(new URL(mcpUrl), fetchApp, 'token');
  await connected;
  for (const name of FAILING_TOOLS) {
    expect(await client.callTool({ name })).toMatchObject({ isError: true });
  }
  await client.close();
}

const outcomesOf = (sink: ReturnType<typeof reportSink>) =>
  sink.calls().map(({ tool_name, status, error_code, handler_ms }) => ({
    tool_name,
    status,
    error_code,
    handler_ms,
  }));

const instrumentedOutcomes = [
  {
    tool_name: 'crash',
    status: 'error',
    error_code: 'thrown:TypeError',
    handler_ms: expect.any(Number),
  },
  {
    tool_name: 'crash_with_string',
    status: 'error',
    error_code: 'thrown:unknown',
    handler_ms: expect.any(Number),
  },
  { tool_name: 'reject', status: 'error', error_code: undefined, handler_ms: expect.any(Number) },
];

function expectNoErrorText(sink: ReturnType<typeof reportSink>) {
  const sent = JSON.stringify(sink.bodies);
  expect(sent).not.toContain(THROWN_TEXT);
  expect(sent).not.toContain('hunter2');
  expect(sent).not.toContain(RETURNED_TEXT);
}

describe('tool handler outcomes', () => {
  test('tell a thrown error from a returned one, with the handler time, on MCP SDK 2.x', async () => {
    const sink = reportSink();
    const app = honoApp(
      createMcpHandler(() => {
        const server = new McpServerV2({ name: 'acme-mcp', version: '1.0.0' });
        clerkInstrumentServer(server);
        registerFailingTools(server);
        return server;
      }),
      { reporting: { fetch: sink.fetch, secretKey: SECRET_KEY } },
    );

    await callFailingTools(app.fetch);
    await app.settled();

    expect(outcomesOf(sink)).toEqual(instrumentedOutcomes);
    expectGoldenShape(sink.bodies);
    expectNoErrorText(sink);
  });

  test('tell a thrown error from a returned one for registerTool on MCP SDK 1.x', async () => {
    const sink = reportSink();
    const app = sdkV1ExpressApp((server) => {
      clerkInstrumentServer(server);
      registerFailingTools(server);
    }, sink);

    await withListening(app, (baseUrl) => callFailingTools(fetch, `${baseUrl}/mcp`));

    await vi.waitFor(() => expect(sink.calls()).toHaveLength(3), { timeout: 3000 });
    expect(outcomesOf(sink)).toEqual(instrumentedOutcomes);
    expectGoldenShape(sink.bodies);
    expectNoErrorText(sink);
  });

  test('tell a thrown error from a returned one for tool on MCP SDK 1.x', async () => {
    const sink = reportSink();
    const app = sdkV1ExpressApp((server) => {
      clerkInstrumentServer(server);
      server.tool('crash', async () => {
        throw new TypeError(THROWN_TEXT);
      });
      server.tool('crash_with_string', 'Throws a string', async () => {
        throw THROWN_TEXT;
      });
      server.tool('reject', async () => ({
        isError: true,
        content: [{ type: 'text', text: RETURNED_TEXT }],
      }));
    }, sink);

    await withListening(app, (baseUrl) => callFailingTools(fetch, `${baseUrl}/mcp`));

    await vi.waitFor(() => expect(sink.calls()).toHaveLength(3), { timeout: 3000 });
    expect(outcomesOf(sink)).toEqual(instrumentedOutcomes);
    expectNoErrorText(sink);
  });

  test('report tools registered before clerkInstrumentServer from the response alone', async () => {
    const sink = reportSink();
    const app = honoApp(
      createMcpHandler(() => {
        const server = new McpServerV2({ name: 'acme-mcp', version: '1.0.0' });
        registerFailingTools(server);
        clerkInstrumentServer(server);
        return server;
      }),
      { reporting: { fetch: sink.fetch, secretKey: SECRET_KEY } },
    );

    await callFailingTools(app.fetch);
    await app.settled();

    expect(outcomesOf(sink)).toEqual(
      FAILING_TOOLS.map((tool_name) => ({
        tool_name,
        status: 'error',
        error_code: undefined,
        handler_ms: undefined,
      })),
    );
    expectGoldenShape(sink.bodies);
    expectNoErrorText(sink);
  });

  test('time only the tools registered after clerkInstrumentServer on the same server', async () => {
    const sink = reportSink();
    const crash = async () => {
      throw new TypeError(THROWN_TEXT);
    };
    const app = sdkV1ExpressApp((server) => {
      server.registerTool('before', { description: 'Registered first' }, crash);
      clerkInstrumentServer(server);
      server.registerTool('after', { description: 'Registered second' }, crash);
    }, sink);

    await withListening(app, async (baseUrl) => {
      const { client, connected } = connectOAuthClient(new URL(`${baseUrl}/mcp`), fetch, 'token');
      await connected;
      await client.callTool({ name: 'before' });
      await client.callTool({ name: 'after' });
      await client.close();
    });

    await vi.waitFor(() => expect(sink.calls()).toHaveLength(2), { timeout: 3000 });
    expect(outcomesOf(sink)).toEqual([
      { tool_name: 'before', status: 'error', error_code: undefined, handler_ms: undefined },
      {
        tool_name: 'after',
        status: 'error',
        error_code: 'thrown:TypeError',
        handler_ms: expect.any(Number),
      },
    ]);
    expectNoErrorText(sink);
  });

  test('name a thrown error by its class when it keeps the name Error', async () => {
    class OrderLookupError extends Error {}
    class Unnamed extends Error {
      override name = 'not an identifier';
    }
    const sink = reportSink();
    const app = honoApp(
      createMcpHandler(() => {
        const server = new McpServerV2({ name: 'acme-mcp', version: '1.0.0' });
        clerkInstrumentServer(server);
        server.registerTool('lookup', { description: 'Throws a subclass' }, async () => {
          throw new OrderLookupError(THROWN_TEXT);
        });
        server.registerTool(
          'lookup_named',
          { description: 'Throws a renamed subclass' },
          async () => {
            throw new Unnamed(THROWN_TEXT);
          },
        );
        server.registerTool('lookup_plain', { description: 'Throws an Error' }, async () => {
          throw new Error(THROWN_TEXT);
        });
        return server;
      }),
      { reporting: { fetch: sink.fetch, secretKey: SECRET_KEY } },
    );

    const { client, connected } = connectOAuthClient(new URL(RESOURCE_URL), app.fetch, 'token');
    await connected;
    for (const name of ['lookup', 'lookup_named', 'lookup_plain']) await client.callTool({ name });
    await client.close();
    await app.settled();

    expect(sink.calls().map((call) => call.error_code)).toEqual([
      'thrown:OrderLookupError',
      'thrown:Unnamed',
      'thrown:Error',
    ]);
    expectNoErrorText(sink);
  });

  test('time handlers that take arguments, on MCP SDK 1.x and 2.x', async () => {
    const throwWith = async ({ order }: { order: string }) => {
      throw new RangeError(order);
    };
    const callWithArguments = async (
      fetchApp: (input: string | URL, init?: RequestInit) => Promise<Response>,
      mcpUrl: string,
      names: string[],
    ) => {
      const { client, connected } = connectOAuthClient(new URL(mcpUrl), fetchApp, 'token');
      await connected;
      for (const name of names) {
        expect(await client.callTool({ name, arguments: { order: THROWN_TEXT } })).toMatchObject({
          isError: true,
        });
      }
      await client.close();
    };
    const thrown = (tool_name: string) => ({
      tool_name,
      status: 'error',
      error_code: 'thrown:RangeError',
      handler_ms: expect.any(Number),
    });

    const v1Sink = reportSink();
    const v1App = sdkV1ExpressApp((server) => {
      clerkInstrumentServer(server);
      server.registerTool('lookup', { inputSchema: { order: z.string() } }, throwWith);
      server.tool('lookup_legacy', 'Looks up an order', { order: z.string() }, throwWith);
    }, v1Sink);
    await withListening(v1App, (baseUrl) =>
      callWithArguments(fetch, `${baseUrl}/mcp`, ['lookup', 'lookup_legacy']),
    );
    await vi.waitFor(() => expect(v1Sink.calls()).toHaveLength(2), { timeout: 3000 });
    expect(outcomesOf(v1Sink)).toEqual([thrown('lookup'), thrown('lookup_legacy')]);
    expectNoErrorText(v1Sink);

    const v2Sink = reportSink();
    const v2App = honoApp(
      createMcpHandler(() => {
        const server = new McpServerV2({ name: 'acme-mcp', version: '1.0.0' });
        clerkInstrumentServer(server);
        server.registerTool('lookup', { inputSchema: z.object({ order: z.string() }) }, throwWith);
        return server;
      }),
      { reporting: { fetch: v2Sink.fetch, secretKey: SECRET_KEY } },
    );
    await callWithArguments(v2App.fetch, RESOURCE_URL, ['lookup']);
    await v2App.settled();
    expect(outcomesOf(v2Sink)).toEqual([thrown('lookup')]);
    expectNoErrorText(v2Sink);
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

  test.each([
    [401, '. Check the secret key'],
    [403, '. MCP analytics may not be enabled for this instance'],
  ])('warn once when the Backend API refuses them with %i', async (status, hint) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = reportSink(status);
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
        `Clerk warning: clerkInstrumentHandler could not report 1 MCP events to Clerk, which answered with status ${status}${hint}`,
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

const REJECTED_TOKEN = 'rejected-token-4f9a';
const VERIFIER_MESSAGE = 'JWT signature for user_2xhFjEI5X2qWRvtV13BzSj8H6Dk is invalid';
const OTHER_RESOURCE_URL = 'https://mcp.example.org/mcp';

// Accepts `token`, with only the `profile` scope, and rejects any other token as Clerk does
const rejectingClerkClient = {
  authenticateRequest: async (request: Request) =>
    request.headers.get('authorization') === 'Bearer token'
      ? clerkClient.authenticateRequest()
      : {
          isAuthenticated: false as const,
          reason: 'token-invalid',
          message: VERIFIER_MESSAGE,
        },
};

type AuthFailureAdapter = 'hono' | 'express' | 'next';

/**
 * Serves `sdkV2Handler()` through the adapter's `clerkInstrumentHandler`, and sends one request to it.
 * @returns The response's status, `WWW-Authenticate` header and body, and how many times the request was received:
 * Node.js's `fetch` sends a request again after a 421
 */
async function sendToAdapter(
  adapter: AuthFailureAdapter,
  options: Record<string, unknown>,
  url: string,
  init: RequestInit,
) {
  const handlerOptions = {
    resourceUrl: RESOURCE_URL,
    clerkClient: rejectingClerkClient,
    ...options,
  };
  let received = 0;
  const read = async (response: Response) => ({
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
    body: await response.text(),
    received: Math.max(received, 1),
  });
  if (adapter === 'hono') {
    const app = honoApp(sdkV2Handler(), handlerOptions as Partial<honoAdapter.McpAuthOptions>);
    const answer = await read(await app.fetch(url, init));
    await app.settled();
    return answer;
  }
  if (adapter === 'next') {
    const route = nextAdapter.clerkInstrumentHandler(
      sdkV2Handler(),
      handlerOptions as nextAdapter.McpAuthOptions,
    );
    return read(await route(new Request(url, withUserAgent(init))));
  }
  const app = express();
  app.use((_req, _res, next) => {
    received++;
    next();
  });
  app.use(express.json());
  app.all(
    '/mcp',
    expressAdapter.clerkInstrumentHandler(
      sdkV2Handler(),
      handlerOptions as expressAdapter.McpAuthOptions,
    ),
  );
  // Express sees the request on its own loopback origin, which a list of resourceUrls doesn't have
  return withListening(app, async (baseUrl) =>
    read(await fetch(`${baseUrl}${new URL(url).pathname}`, withUserAgent(init))),
  );
}

function authFailureInit(authorization: string | undefined, body?: unknown): RequestInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  if (authorization !== undefined) headers.authorization = authorization;
  return {
    method: 'POST',
    headers,
    body: JSON.stringify(
      body ?? {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
      },
    ),
  };
}

const ADDRESSES: Record<AuthFailureAdapter, Record<string, string>> = {
  hono: { ip_address: '203.0.113.7' },
  express: { ip_address: '127.0.0.1' },
  next: {},
};

const IDENTITY = { user_id: USER_ID, client_id: CLIENT_ID, oauth_access_token_id: TOKEN_ID };

describe.each<AuthFailureAdapter>(['hono', 'express', 'next'])(
  'auth failure reports from clerkInstrumentHandler on %s',
  (adapter) => {
    const reported = (sink: ReturnType<typeof reportSink>, count = 1) =>
      vi.waitFor(() => expect(sink.calls()).toHaveLength(count), { timeout: 3000 });

    test.each([
      {
        name: 'a request without a token',
        authorization: undefined,
        options: {},
        url: RESOURCE_URL,
        status: 401,
        event: { reason: 'missing_token', http_status: 401 },
      },
      {
        name: 'a request with a token Clerk rejected',
        authorization: `Bearer ${REJECTED_TOKEN}`,
        options: {},
        url: RESOURCE_URL,
        status: 401,
        event: { reason: 'invalid_token', http_status: 401, verifier_code: 'token-invalid' },
      },
      {
        name: 'a token without the required scopes',
        authorization: 'Bearer token',
        options: { requiredScopes: ['profile', 'admin'] },
        url: RESOURCE_URL,
        status: 403,
        event: { reason: 'insufficient_scope', http_status: 403, ...IDENTITY },
      },
      {
        name: 'a request to an origin no resourceUrl lists',
        authorization: 'Bearer token',
        options: { resourceUrl: [RESOURCE_URL, OTHER_RESOURCE_URL] },
        url: 'https://mcp.example.net/mcp',
        status: 421,
        event: { reason: 'misdirected_request', http_status: 421 },
      },
    ])(
      'reports $name, and answers it as before',
      async ({ authorization, options, url, status, event }) => {
        const sink = reportSink();
        const answer = await sendToAdapter(
          adapter,
          { ...options, reporting: { fetch: sink.fetch, secretKey: SECRET_KEY } },
          url,
          authFailureInit(authorization),
        );
        const unreported = await sendToAdapter(
          adapter,
          options,
          url,
          authFailureInit(authorization),
        );

        expect(answer).toEqual(unreported);
        expect(answer.status).toBe(status);
        await reported(sink, answer.received);
        expect(sink.calls()).toEqual(
          Array.from({ length: answer.received }, () => ({
            type: 'auth_failure',
            occurred_at: expect.any(Number),
            method: 'tools/call',
            tool_name: 'ping',
            user_agent: USER_AGENT,
            ...ADDRESSES[adapter],
            ...event,
          })),
        );
        expectGoldenShape(sink.bodies, {
          exact: adapter === 'hono' && (status === 403 || event.reason === 'invalid_token'),
        });
        const sent = JSON.stringify(sink.bodies);
        expect(sent).not.toContain(REJECTED_TOKEN);
        expect(sent).not.toContain(VERIFIER_MESSAGE);
        expect(sent).not.toContain('"arguments"');
      },
    );

    test('reports nothing when reporting is off', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const answer = await sendToAdapter(adapter, {}, RESOURCE_URL, authFailureInit(undefined));

      expect(answer.status).toBe(401);
      expect(
        fetchSpy.mock.calls.filter(([input]) => String(input).includes('/v1/mcp_events')),
      ).toEqual([]);
    });

    test('reports no method or tool name it cannot read, or that the Backend API would refuse', async () => {
      const sink = reportSink();
      const reporting = { fetch: sink.fetch, secretKey: SECRET_KEY };
      const init = authFailureInit(undefined);
      await sendToAdapter(adapter, { reporting }, RESOURCE_URL, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'content-type': 'text/plain' },
        body: 'not json',
      });
      await sendToAdapter(
        adapter,
        { reporting },
        RESOURCE_URL,
        authFailureInit(undefined, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'look up hunter2@example.com', arguments: {} },
        }),
      );
      await sendToAdapter(
        adapter,
        { reporting },
        RESOURCE_URL,
        // Over the 64 KiB read for a failure, and under the 100 KB `express.json()` takes by default
        authFailureInit(undefined, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ping', arguments: { padding: 'x'.repeat(80 * 1024) } },
        }),
      );

      await reported(sink, 3);
      const [unreadable, unnamed, tooLarge] = sink.calls();
      expect(unreadable).not.toHaveProperty('method');
      expect(unnamed).toMatchObject({ reason: 'missing_token', method: 'tools/call' });
      expect(tooLarge).not.toHaveProperty('method');
      for (const event of sink.calls()) expect(event).not.toHaveProperty('tool_name');
      expect(JSON.stringify(sink.bodies)).not.toContain('hunter2');
    });

    test('reports the method of the first message in a batch, and leaves out a tool reporting.tools filters', async () => {
      const sink = reportSink();
      await sendToAdapter(
        adapter,
        {
          reporting: {
            fetch: sink.fetch,
            secretKey: SECRET_KEY,
            serverName: 'acme-mcp',
            tools: (name: string) => name !== 'ping',
          },
        },
        RESOURCE_URL,
        authFailureInit(undefined, [
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]),
      );

      await reported(sink);
      expect(sink.calls()[0]).toMatchObject({ method: 'tools/call', server_name: 'acme-mcp' });
      expect(sink.calls()[0]).not.toHaveProperty('tool_name');
    });

    test('reports no identity for a 403 when identity is off, or IP address and user agent when they are', async () => {
      const sink = reportSink();
      await sendToAdapter(
        adapter,
        {
          requiredScopes: ['admin'],
          reporting: {
            fetch: sink.fetch,
            secretKey: SECRET_KEY,
            identity: false,
            ipAddress: false,
            userAgent: false,
          },
        },
        RESOURCE_URL,
        authFailureInit('Bearer token'),
      );

      await reported(sink);
      expect(sink.calls()).toEqual([
        {
          type: 'auth_failure',
          occurred_at: expect.any(Number),
          reason: 'insufficient_scope',
          http_status: 403,
          method: 'tools/call',
          tool_name: 'ping',
        },
      ]);
    });
  },
);
