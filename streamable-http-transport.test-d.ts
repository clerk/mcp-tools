import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  McpServer as McpServerV2,
  WebStandardStreamableHTTPServerTransport as WebStandardStreamableHTTPServerTransportV2,
} from '@modelcontextprotocol/server';
import { describe, expectTypeOf, test } from 'vitest';

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

  test("rejects the other adapter's transport class", () => {
    // @ts-expect-error the Node.js transport writes to a Node.js response instead of returning a Response
    honoStreamableHttpHandler(createServer, StreamableHTTPServerTransport);
    // @ts-expect-error the web-standard transport takes a Request instead of a Node.js request and response
    expressStreamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport);
  });
});

// The deprecated handler takes no options, so it has nowhere to take `reporting`: clerkInstrumentHandler reports
describe('the streamableHttpHandler arguments', () => {
  const createServer = () => new McpServer({ name: 'test-server', version: '1.0.0' });

  test('are only the server factory and the transport class, with no options to take reporting', () => {
    expectTypeOf<Parameters<typeof honoStreamableHttpHandler>['length']>().toEqualTypeOf<2>();
    expectTypeOf<Parameters<typeof expressStreamableHttpHandler>['length']>().toEqualTypeOf<2>();
    honoStreamableHttpHandler(
      createServer,
      WebStandardStreamableHTTPServerTransport,
      // @ts-expect-error streamableHttpHandler cannot report: serve the route with clerkInstrumentHandler instead
      { reporting: true },
    );
    expressStreamableHttpHandler(
      createServer,
      StreamableHTTPServerTransport,
      // @ts-expect-error streamableHttpHandler cannot report: serve the route with clerkInstrumentHandler instead
      { reporting: true },
    );
  });
});
