import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  McpServer as McpServerV2,
  WebStandardStreamableHTTPServerTransport as WebStandardStreamableHTTPServerTransportV2,
} from '@modelcontextprotocol/server';
import { describe, test } from 'vitest';

import { streamableHttpHandler as expressStreamableHttpHandler } from './express';
import { streamableHttpHandler as honoStreamableHttpHandler } from './hono';

// The adapters describe the SDK's server and transports structurally so that they never import the SDK. These checks
// fail when the SDK's classes stop matching those descriptions.
describe('the streamableHttpHandler transport argument', () => {
  const createServer = () => new McpServer({ name: 'test-server', version: '1.0.0' });

  test('accepts the SDK McpServer and transport classes without annotations', () => {
    honoStreamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport);
    expressStreamableHttpHandler(createServer, StreamableHTTPServerTransport);
  });

  test('accepts the SDK 2.x McpServer and web-standard transport', () => {
    honoStreamableHttpHandler(
      () => new McpServerV2({ name: 'test-server', version: '1.0.0' }),
      WebStandardStreamableHTTPServerTransportV2,
    );
  });

  test('rejects a server object in place of the factory', () => {
    // @ts-expect-error each request needs its own server, so a shared server object is not accepted
    honoStreamableHttpHandler(createServer(), WebStandardStreamableHTTPServerTransport);
    // @ts-expect-error each request needs its own server, so a shared server object is not accepted
    expressStreamableHttpHandler(createServer(), StreamableHTTPServerTransport);
  });

  test("rejects the other adapter's transport class", () => {
    // @ts-expect-error the Node.js transport writes to a Node.js response instead of returning a Response
    honoStreamableHttpHandler(createServer, StreamableHTTPServerTransport);
    // @ts-expect-error the web-standard transport takes a Request instead of a Node.js request and response
    expressStreamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport);
  });
});
