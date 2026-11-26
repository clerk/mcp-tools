// The MCP App view helper, registered as customers do with `server.registerResource(...view)` and read back with an
// MCP SDK 1.x client, from servers on MCP SDK 1.x and 2.x.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler, McpServer as McpServerV2 } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { isAppView } from './app-view-registry';
import { type McpAppViewResourceOptions, mcpAppViewResource } from './tools';
import { connectTool } from './test/mcp-harness';

const HTML =
  '<!DOCTYPE html><html><head><meta name="color-scheme" content="light dark"></head><body></body></html>';

// Each test names its own URI: the template warning is logged once for each URI per process
let counter = 0;
const nextUri = () => `ui://views/view-${++counter}.html` as const;

async function readV1(options: McpAppViewResourceOptions) {
  const client = await connectTool((server) => {
    server.registerResource(...mcpAppViewResource(options));
  });
  try {
    return {
      listed: (await client.listResources()).resources,
      read: await client.readResource({ uri: options.uri }),
    };
  } finally {
    await client.close();
  }
}

async function readV2(options: McpAppViewResourceOptions) {
  const handler = createMcpHandler(() => {
    const server = new McpServerV2({ name: 'views', version: '0.0.0' });
    server.registerResource(...mcpAppViewResource(options));
    return server;
  });
  const client = new Client({ name: 'host', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://views.example/mcp'), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }),
  );
  try {
    return {
      listed: (await client.listResources()).resources,
      read: await client.readResource({ uri: options.uri }),
    };
  } finally {
    await client.close();
  }
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe.each([
  ['MCP SDK 1.x', readV1],
  ['MCP SDK 2.x', readV2],
])('mcpAppViewResource on %s', (_sdk, read) => {
  test('lists the view as an MCP App and reads back its HTML with _meta.ui on the content item', async () => {
    const uri = nextUri();
    const { listed, read: result } = await read({
      name: 'user_card',
      uri,
      title: 'User card',
      description: 'Shows a Clerk user',
      html: HTML,
      csp: {
        resourceDomains: ['https://img.clerk.com', 'https://*.clerkstage.dev'],
        connectDomains: ['wss://realtime.example.com'],
        frameDomains: [],
      },
      prefersBorder: true,
    });

    expect(listed).toEqual([
      {
        name: 'user_card',
        uri,
        title: 'User card',
        description: 'Shows a Clerk user',
        mimeType: 'text/html;profile=mcp-app',
      },
    ]);
    expect(result.contents).toEqual([
      {
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: HTML,
        _meta: {
          ui: {
            csp: {
              connectDomains: ['wss://realtime.example.com'],
              resourceDomains: ['https://img.clerk.com', 'https://*.clerkstage.dev'],
            },
            prefersBorder: true,
          },
        },
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    ['no csp', {}],
    [
      'a csp whose every list is empty',
      { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } },
    ],
  ])('omits _meta for a view with %s and no other UI settings', async (_name, settings) => {
    const uri = nextUri();
    const { read: result } = await read({ name: 'plain', uri, html: HTML, ...settings });
    expect(result.contents).toEqual([{ uri, mimeType: 'text/html;profile=mcp-app', text: HTML }]);
  });
});

describe('mcpAppViewResource options', () => {
  test.each([
    '*',
    'https:',
    'https://',
    'https://*',
    'data:',
    "'self'",
    'example.com',
    'https://cdn.example.com/assets',
    '',
  ])('rejects the CSP origin %j', (origin) => {
    expect(() =>
      mcpAppViewResource({
        name: 'v',
        uri: nextUri(),
        html: HTML,
        csp: { connectDomains: [origin] },
      }),
    ).toThrow(
      'Clerk error: mcpAppViewResource csp.connectDomains must list origins, such as https://api.example.com',
    );
  });

  test.each([
    'https://cdn.example.com',
    'https://*.example.com',
    'wss://realtime.example.com',
    'http://localhost:3000',
  ])('accepts the CSP origin %j', (origin) => {
    expect(() =>
      mcpAppViewResource({
        name: 'v',
        uri: nextUri(),
        html: HTML,
        csp: { baseUriDomains: [origin] },
      }),
    ).not.toThrow();
  });

  test.each([
    [
      { name: 'v', uri: 'docs://view', html: HTML },
      'Clerk error: mcpAppViewResource uri must be a ui:// URI, such as ui://my-server/view.html',
    ],
    [
      { name: '', uri: 'ui://x', html: HTML },
      'Clerk error: mcpAppViewResource name must be a non-empty string',
    ],
    [
      { name: 'v', uri: 'ui://x', html: 1 },
      "Clerk error: mcpAppViewResource html must be the view's HTML document, as a string",
    ],
    [
      { name: 'v', uri: 'ui://x', html: HTML, csp: { scriptDomains: [] } },
      'Clerk error: mcpAppViewResource csp has no scriptDomains option. It takes any of connectDomains, resourceDomains, frameDomains, baseUriDomains',
    ],
    [
      { name: 'v', uri: 'ui://x', html: HTML, csp: { frameDomains: 'https://a.example' } },
      'Clerk error: mcpAppViewResource csp.frameDomains must list origins',
    ],
    [
      { name: 'v', uri: 'ui://x', html: HTML, mimeType: 'text/html' },
      'Clerk error: mcpAppViewResource has no mimeType option',
    ],
    [
      { name: 'v', uri: 'ui://x', html: HTML, prefersBorder: 'yes' },
      'Clerk error: mcpAppViewResource prefersBorder must be true or false',
    ],
  ])('rejects %j', (options, message) => {
    expect(() => mcpAppViewResource(options as McpAppViewResourceOptions)).toThrow(message);
  });

  test.each([
    [
      'without <!DOCTYPE html>',
      '<html><head><meta name="color-scheme" content="light dark"></head></html>',
      'does not start with <!DOCTYPE html>',
    ],
    [
      'without color-scheme',
      '<!DOCTYPE html><html><head></head></html>',
      'declares no color-scheme',
    ],
    [
      'with a Clerk secret key',
      HTML.replace('<body>', '<body>sk_live_abc123'),
      'contains a Clerk secret key',
    ],
    [
      'with a Clerk test secret key',
      HTML.replace('<body>', '<body>sk_test_abc123'),
      'contains a Clerk secret key',
    ],
  ])('warns once, without throwing, for a template %s', (_name, html, problem) => {
    const uri = nextUri();
    expect(() => mcpAppViewResource({ name: 'v', uri, html })).not.toThrow();
    mcpAppViewResource({ name: 'v', uri, html });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0]!;
    expect(message).toMatch(/^Clerk warning: mcpAppViewResource /);
    expect(message).toContain(uri);
    expect(message).toContain(problem);
    expect(message).not.toContain('abc123');
  });

  test('accepts a lowercase doctype, which HTML treats the same', () => {
    mcpAppViewResource({
      name: 'v',
      uri: nextUri(),
      html: HTML.replace('<!DOCTYPE html>', '<!doctype html>'),
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

// publicAccess.views opens exactly the URIs this records
describe('mcpAppViewResource view registry', () => {
  test('records the exact URI of each view it builds', () => {
    const uri = nextUri();
    expect(isAppView(uri)).toBe(false);
    mcpAppViewResource({ name: 'v', uri, html: HTML });
    expect(isAppView(uri)).toBe(true);
    for (const other of [`${uri}?x`, uri.toUpperCase(), uri.slice(0, -1), 7]) {
      expect(isAppView(other)).toBe(false);
    }
  });

  test('records nothing for options it rejects', () => {
    const uri = nextUri();
    expect(() => mcpAppViewResource({ name: '', uri, html: HTML })).toThrow('Clerk error:');
    expect(isAppView(uri)).toBe(false);
  });
});
