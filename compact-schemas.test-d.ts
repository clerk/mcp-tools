import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpServer as McpServerV2 } from '@modelcontextprotocol/server';
import { describe, expectTypeOf, test } from 'vitest';

import {
  type StreamableHttpHandlerOptions,
  streamableHttpHandler as expressHandler,
} from './express';
import { streamableHttpHandler as honoHandler } from './hono';
import { withClerkMcpAuth } from './next';
import {
  type ToolListMeasurement,
  compactJsonSchema,
  compactToolSchemas,
  measureToolList,
} from './server';

describe('tool schema compaction options', () => {
  const createServer = () => new McpServer({ name: 'test', version: '1.0.0' });

  test('streamableHttpHandler takes compactSchemas as its opt-out', () => {
    honoHandler(createServer, WebStandardStreamableHTTPServerTransport, { compactSchemas: false });
    expressHandler(createServer, StreamableHTTPServerTransport, { compactSchemas: true });
    expressHandler(createServer, StreamableHTTPServerTransport, {});
    // @ts-expect-error compactSchemas is a boolean
    honoHandler(createServer, WebStandardStreamableHTTPServerTransport, { compactSchemas: 'no' });
    // @ts-expect-error there is no other option
    expressHandler(createServer, StreamableHTTPServerTransport, { compact: false });
    expectTypeOf<StreamableHttpHandlerOptions>().toEqualTypeOf<{
      compactSchemas?: boolean | undefined;
    }>();
  });

  test('withClerkMcpAuth takes compactSchemas as its opt-out', () => {
    const handler = async () => new Response();
    withClerkMcpAuth(handler, {
      resourceUrl: 'https://mcp.example.com/mcp',
      compactSchemas: false,
    });
    // @ts-expect-error compactSchemas is a boolean
    withClerkMcpAuth(handler, { resourceUrl: 'https://mcp.example.com/mcp', compactSchemas: 1 });
  });

  test('compactToolSchemas returns the server it is given, on SDK 1.x and 2.x', () => {
    expectTypeOf(compactToolSchemas(createServer())).toEqualTypeOf<McpServer>();
    expectTypeOf(
      compactToolSchemas(new McpServerV2({ name: 'test', version: '1.0.0' })),
    ).toEqualTypeOf<McpServerV2>();
    // @ts-expect-error it takes a server
    compactToolSchemas({});
  });

  test('compactJsonSchema maps a schema object to a schema object', () => {
    expectTypeOf(compactJsonSchema({ type: 'object' })).toEqualTypeOf<Record<string, unknown>>();
  });

  test('measureToolList takes a server or a tools/list result', () => {
    expectTypeOf(measureToolList(createServer())).toEqualTypeOf<Promise<ToolListMeasurement>>();
    expectTypeOf(measureToolList({ tools: [{ name: 'a', inputSchema: {} }] })).toEqualTypeOf<
      Promise<ToolListMeasurement>
    >();
    measureToolList(createServer(), { compactSchemas: false });
    // @ts-expect-error a list of tools, not a bare array
    measureToolList([]);
  });
});
