import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as McpServerV2 } from '@modelcontextprotocol/server';
import { describe, test } from 'vitest';

import { type McpAppViewResourceOptions, mcpAppViewResource } from './tools';

const html = '<!DOCTYPE html>';

describe('mcpAppViewResource', () => {
  test('spreads into registerResource on MCP SDK 1.x and 2.x', () => {
    const view = mcpAppViewResource({ name: 'card', uri: 'ui://server/card.html', html });
    new McpServer({ name: 'v1', version: '0.0.0' }).registerResource(...view);
    new McpServerV2({ name: 'v2', version: '0.0.0' }).registerResource(...view);
  });

  test('takes the CSP as readonly origin lists', () => {
    const csp = {
      resourceDomains: ['https://cdn.example.com'],
    } as const satisfies McpAppViewResourceOptions['csp'];
    mcpAppViewResource({
      name: 'card',
      uri: 'ui://server/card.html',
      html,
      csp,
      prefersBorder: true,
    });
  });

  test('rejects a URI outside ui://, an unknown CSP list, and a mimeType', () => {
    // @ts-expect-error a view's URI uses the ui:// scheme
    mcpAppViewResource({ name: 'card', uri: 'docs://card', html });
    // @ts-expect-error not a CSP list MCP Apps defines
    mcpAppViewResource({ name: 'card', uri: 'ui://card', html, csp: { scriptDomains: [] } });
    // @ts-expect-error the mime type is always text/html;profile=mcp-app
    mcpAppViewResource({ name: 'card', uri: 'ui://card', html, mimeType: 'text/html' });
  });
});
