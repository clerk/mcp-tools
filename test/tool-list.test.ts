// End to end: `tools/list` as an MCP client reads it from servers the adapters serve, with schema compaction on by
// default and off with `compactSchemas: false`, on MCP SDK 1.x and 2.x.
import { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport as WebStandardTransportV1 } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  createMcpHandler as createMcpHandlerV2,
  McpServer as McpServerV2,
  WebStandardStreamableHTTPServerTransport as WebStandardTransportV2,
} from '@modelcontextprotocol/server';
import express from 'express';
import { Hono } from 'hono';
import { createMcpHandler } from 'mcp-handler';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import * as expressAdapter from '../express';
import * as honoAdapter from '../hono';
import type { AuthInfo } from '../mcp-types';
import * as nextAdapter from '../next';
import { compactToolSchemas } from '../server';
import { connectOAuthClient, expiresAt, oauthMetadata, withListening } from './mcp-harness';

const ORIGIN = 'https://mcp.example.com';
const MCP_URL = new URL('/mcp', ORIGIN);
const TOKEN = 'token_full';

function verifyToken(token: string): AuthInfo | undefined {
  return token === TOKEN ? { token, clientId: 'client_1', scopes: [], expiresAt } : undefined;
}

type Registrar = {
  registerTool: (
    name: string,
    config: Record<string, unknown>,
    cb: () => Promise<unknown>,
  ) => unknown;
};

// One tool with a raw Zod shape and one with a Zod object, which the SDK reads as a Standard Schema
function registerTools(server: Registrar) {
  const ok = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });
  server.registerTool(
    'raw_shape',
    {
      description: 'Takes a raw shape',
      inputSchema: {
        query: z.string(),
        labels: z.record(z.string(), z.unknown()),
        additionalProperties: z.object({ strict: z.boolean() }).strict(),
      },
    },
    ok,
  );
  server.registerTool(
    'standard_schema',
    {
      description: 'Takes a Zod object',
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.looseObject({ count: z.number() }),
    },
    ok,
  );
}

const SDK_V2_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SDK_V1_DIALECT = 'http://json-schema.org/draft-07/schema#';

// What each SDK lists for the tools above, as it serves them without compaction
function verbatim(dialect: string) {
  return {
    raw_shape: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        labels: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
        additionalProperties: {
          type: 'object',
          properties: { strict: { type: 'boolean' } },
          required: ['strict'],
          additionalProperties: false,
        },
      },
      required: ['query', 'labels', 'additionalProperties'],
      $schema: dialect,
    },
    standard_schema: {
      input: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        $schema: dialect,
      },
      output: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
        $schema: dialect,
        additionalProperties: {},
      },
    },
  };
}

// The same schemas compacted: no 2020-12 `$schema` (another dialect stays), no empty `additionalProperties`, and the
// property named `additionalProperties` and the `false` one kept
function compacted(dialect: string) {
  const keep = dialect === SDK_V2_DIALECT ? {} : { $schema: dialect };
  return {
    raw_shape: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        labels: { type: 'object', propertyNames: { type: 'string' } },
        additionalProperties: {
          type: 'object',
          properties: { strict: { type: 'boolean' } },
          required: ['strict'],
          additionalProperties: false,
        },
      },
      required: ['query', 'labels', 'additionalProperties'],
      ...keep,
    },
    standard_schema: {
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], ...keep },
      output: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
        ...keep,
      },
    },
  };
}

async function listedSchemas(
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
) {
  const { client, connected } = connectOAuthClient(MCP_URL, fetchImpl, TOKEN);
  await connected;
  try {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    return {
      raw_shape: byName.raw_shape?.inputSchema,
      standard_schema: {
        input: byName.standard_schema?.inputSchema,
        output: byName.standard_schema?.outputSchema,
      },
    };
  } finally {
    await client.close();
  }
}

function withMetadata(serve: (req: Request) => Promise<Response>) {
  return async (input: string | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    return (
      oauthMetadata(ORIGIN, path, []) ??
      (path === '/mcp' ? serve(req) : new Response('Not Found', { status: 404 }))
    );
  };
}

type Options = { compactSchemas?: boolean } | undefined;

const honoServer = (sdk: 'v1' | 'v2', options: Options) => {
  const app = new Hono();
  const createServer = () => {
    const server =
      sdk === 'v1'
        ? new McpServerV1({ name: 'tools', version: '0.0.0' })
        : new McpServerV2({ name: 'tools', version: '0.0.0' });
    registerTools(server as unknown as Registrar);
    return server;
  };
  app.all(
    '/mcp',
    honoAdapter.mcpAuth({ verifyToken, resourceUrl: MCP_URL.href }),
    sdk === 'v1'
      ? honoAdapter.streamableHttpHandler(
          createServer as () => McpServerV1,
          WebStandardTransportV1,
          options,
        )
      : honoAdapter.streamableHttpHandler(
          createServer as () => McpServerV2,
          WebStandardTransportV2,
          options,
        ),
  );
  return withMetadata(async (req) => app.fetch(req));
};

const nextServer = (options: Options) => {
  const handler = createMcpHandler((server) => registerTools(server as unknown as Registrar));
  const route = nextAdapter.withClerkMcpAuth(handler, {
    verifyToken: async (token) => verifyToken(token),
    resourceUrl: MCP_URL.href,
    ...options,
  });
  return withMetadata(route);
};

async function expressSchemas(options: Options) {
  const app = express();
  app.all(
    '/mcp',
    express.json(),
    expressAdapter.mcpAuth({ verifyToken, resourceUrl: MCP_URL.href }),
    expressAdapter.streamableHttpHandler(
      () => {
        const server = new McpServerV1({ name: 'tools', version: '0.0.0' });
        registerTools(server as unknown as Registrar);
        return server;
      },
      StreamableHTTPServerTransport,
      options,
    ),
  );
  return withListening(app, (baseUrl) =>
    listedSchemas(
      withMetadata((req) => {
        const url = new URL(req.url);
        return fetch(`${baseUrl}${url.pathname}`, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'POST' ? req.body : undefined,
          duplex: 'half',
        } as RequestInit);
      }),
    ),
  );
}

const SERVERS: {
  name: string;
  dialect: string;
  schemas: (options: Options) => Promise<unknown>;
}[] = [
  {
    name: 'Hono on SDK 2.x',
    dialect: SDK_V2_DIALECT,
    schemas: (o) => listedSchemas(honoServer('v2', o)),
  },
  {
    name: 'Hono on SDK 1.x',
    dialect: SDK_V1_DIALECT,
    schemas: (o) => listedSchemas(honoServer('v1', o)),
  },
  { name: 'Express on SDK 1.x', dialect: SDK_V1_DIALECT, schemas: expressSchemas },
  // `mcp-handler`'s SDK copy writes the 2020-12 `$schema`
  {
    name: 'Next.js with mcp-handler',
    dialect: SDK_V2_DIALECT,
    schemas: (o) => listedSchemas(nextServer(o)),
  },
];

describe('tools/list schemas served through the adapters', () => {
  test.each(SERVERS)('$name compacts them by default', async ({ dialect, schemas }) => {
    expect(await schemas(undefined)).toEqual(compacted(dialect));
  });

  test.each(SERVERS)(
    '$name lists them verbatim with compactSchemas: false',
    async ({ dialect, schemas }) => {
      expect(await schemas({ compactSchemas: false })).toEqual(verbatim(dialect));
    },
  );

  test.each(SERVERS)(
    '$name compacts them with compactSchemas: true',
    async ({ dialect, schemas }) => {
      expect(await schemas({ compactSchemas: true })).toEqual(compacted(dialect));
    },
  );
});

describe('compactToolSchemas on a server served without the adapters', () => {
  test.each([
    { name: 'SDK 1.x', dialect: SDK_V1_DIALECT },
    { name: 'SDK 2.x', dialect: SDK_V2_DIALECT },
  ])('compacts tools/list on $name', async ({ name, dialect }) => {
    const fetchImpl = withMetadata(async (req) => {
      const server =
        name === 'SDK 1.x'
          ? new McpServerV1({ name: 'tools', version: '0.0.0' })
          : new McpServerV2({ name: 'tools', version: '0.0.0' });
      registerTools(server as unknown as Registrar);
      compactToolSchemas(server);
      const transport =
        name === 'SDK 1.x'
          ? new WebStandardTransportV1({ sessionIdGenerator: undefined, enableJsonResponse: true })
          : new WebStandardTransportV2({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await (server as McpServerV1).connect(transport as WebStandardTransportV1);
      return transport.handleRequest(req);
    });

    expect(await listedSchemas(fetchImpl)).toEqual(compacted(dialect));
  });
});

test('compactToolSchemas compacts tools/list served by SDK 2.x createMcpHandler', async () => {
  const handler = createMcpHandlerV2(() => {
    const server = new McpServerV2({ name: 'tools', version: '0.0.0' });
    registerTools(server as unknown as Registrar);
    return compactToolSchemas(server);
  });
  expect(await listedSchemas(withMetadata((req) => Promise.resolve(handler.fetch(req))))).toEqual(
    compacted(SDK_V2_DIALECT),
  );
});

// A `tools/list` result with one tool whose schemas carry both keywords compaction leaves out
const TOOLS_LIST_REPLY = {
  jsonrpc: '2.0',
  id: 7,
  result: {
    tools: [
      {
        name: 'search',
        inputSchema: { $schema: SDK_V2_DIALECT, type: 'object', additionalProperties: {} },
      },
    ],
  },
};
const COMPACTED_REPLY = {
  ...TOOLS_LIST_REPLY,
  result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] },
};

describe('withClerkMcpAuth compaction of the route response', () => {
  const route = (body: string, contentType: string) =>
    nextAdapter.withClerkMcpAuth(
      async () =>
        new Response(body, {
          headers: { 'content-type': contentType, 'content-length': String(body.length) },
        }),
      { verifyToken: async (token) => verifyToken(token), resourceUrl: MCP_URL.href },
    );
  const request = (method: string) =>
    new Request(MCP_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: {} }),
    });

  test('rewrites a JSON reply to tools/list', async () => {
    const res = await route(
      JSON.stringify(TOOLS_LIST_REPLY),
      'application/json',
    )(request('tools/list'));
    expect(res.headers.get('content-length')).toBeNull();
    expect(await res.json()).toEqual(COMPACTED_REPLY);
  });

  test('rewrites an event-stream reply to tools/list', async () => {
    const res = await route(
      `event: message\ndata: ${JSON.stringify(TOOLS_LIST_REPLY)}\n\n`,
      'text/event-stream',
    )(request('tools/list'));
    expect(await res.text()).toBe(`event: message\ndata: ${JSON.stringify(COMPACTED_REPLY)}\n\n`);
  });

  test('passes the reply to another method through untouched', async () => {
    const body = JSON.stringify(TOOLS_LIST_REPLY);
    const res = await route(body, 'application/json')(request('tools/call'));
    expect(await res.text()).toBe(body);
  });
});

describe('the compaction options', () => {
  const createServer = () => new McpServerV1({ name: 'tools', version: '0.0.0' });

  test.each([
    {
      name: 'Hono',
      make: (o: unknown) =>
        honoAdapter.streamableHttpHandler(createServer, WebStandardTransportV1, o as Options),
    },
    {
      name: 'Express',
      make: (o: unknown) =>
        expressAdapter.streamableHttpHandler(
          createServer,
          StreamableHTTPServerTransport,
          o as Options,
        ),
    },
  ])('$name streamableHttpHandler rejects a bad option at creation', ({ make }) => {
    expect(() => make({ compactSchemas: 'no' })).toThrow(
      'Clerk error: streamableHttpHandler compactSchemas must be true or false',
    );
    expect(() => make({ compact: false })).toThrow(
      'Clerk error: streamableHttpHandler has no compact option. It takes compactSchemas',
    );
    expect(() => make(false)).toThrow('Clerk error: streamableHttpHandler takes an options object');
  });

  test('withClerkMcpAuth rejects a compactSchemas that is not a boolean', () => {
    expect(() =>
      nextAdapter.withClerkMcpAuth(async () => new Response(), {
        verifyToken: async () => undefined,
        compactSchemas: 'no' as never,
      }),
    ).toThrow('Clerk error: withClerkMcpAuth compactSchemas must be true or false');
  });

  test('compactToolSchemas rejects something that is not a server', () => {
    expect(() => compactToolSchemas({} as never)).toThrow(
      /^Clerk error: compactToolSchemas takes an MCP server/,
    );
  });
});
