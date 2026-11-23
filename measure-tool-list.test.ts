// The size of a tool list as a client receives it, measured on MCP SDK 1.x and 2.x servers and on a client's
// `listTools()` result.
import { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport as TransportV1 } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  McpServer as McpServerV2,
  WebStandardStreamableHTTPServerTransport as TransportV2,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { measureToolList, streamableHttpHandler } from './hono';
import { connectOAuthClient } from './test/mcp-harness';

// Counted by hand: each tool's JSON is 81 and 77 characters, and `{"tools":[`, `,` and `]}` add 13
const RESULT = {
  tools: [
    { name: 'a', description: 'abcd', inputSchema: { type: 'object' }, _meta: { k: 1 } },
    { name: 'b', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
  ],
};

function createServer(sdk: 'v1' | 'v2') {
  const server =
    sdk === 'v1'
      ? new McpServerV1({ name: 'measured', version: '0.0.0' })
      : new McpServerV2({ name: 'measured', version: '0.0.0' });
  (server as McpServerV2).registerTool(
    'echo',
    {
      description: 'Echoes the text',
      inputSchema: z.object({ text: z.string(), extra: z.record(z.string(), z.unknown()) }),
    },
    async () => ({ content: [] }),
  );
  return server as McpServerV2;
}

// The tool list a client reads from the server served by `streamableHttpHandler`
async function servedToolList(sdk: 'v1' | 'v2') {
  const app = new Hono();
  app.post(
    '/mcp',
    sdk === 'v1'
      ? streamableHttpHandler(() => createServer(sdk) as unknown as McpServerV1, TransportV1)
      : streamableHttpHandler(() => createServer(sdk), TransportV2),
  );
  const { client, connected } = connectOAuthClient(
    new URL('https://mcp.example.com/mcp'),
    async (input, init) => app.fetch(new Request(input, init)),
    undefined,
  );
  await connected;
  try {
    return await client.listTools();
  } finally {
    await client.close();
  }
}

describe('measureToolList', () => {
  test('counts the characters of each tool and of the whole list, and approximates its tokens', async () => {
    expect(await measureToolList(RESULT)).toEqual({
      tools: [
        { name: 'a', characters: 81, description: 4, inputSchema: 17, outputSchema: 0, meta: 7 },
        { name: 'b', characters: 77, description: 0, inputSchema: 17, outputSchema: 17, meta: 0 },
      ],
      totals: { characters: 171, description: 4, inputSchema: 34, outputSchema: 17, meta: 7 },
      approximateTokens: 43,
    });
  });

  test.each(['v1', 'v2'] as const)(
    'measures an SDK %s server as streamableHttpHandler serves its tool list',
    async (sdk) => {
      const served = await servedToolList(sdk);
      expect(await measureToolList(createServer(sdk))).toEqual(await measureToolList(served));
    },
  );

  test.each(['v1', 'v2'] as const)(
    'measures an SDK %s server without compaction with compactSchemas: false',
    async (sdk) => {
      const compacted = await measureToolList(createServer(sdk));
      const verbatim = await measureToolList(createServer(sdk), { compactSchemas: false });
      // The empty `additionalProperties` of the record, `,"additionalProperties":{}`, is 26 characters
      expect(verbatim.tools[0]!.inputSchema - compacted.tools[0]!.inputSchema).toBe(
        sdk === 'v2' ? 26 + ',"$schema":"https://json-schema.org/draft/2020-12/schema"'.length : 26,
      );
      expect(verbatim.tools[0]!.description).toBe('Echoes the text'.length);
    },
  );

  test('throws a Clerk error for something that is neither a server nor a tools/list result', async () => {
    await expect(measureToolList({} as never)).rejects.toThrow(/^Clerk error: measureToolList/);
  });
});
