import type { Context } from 'hono';
import { describe, expectTypeOf, test } from 'vitest';

import {
  type AICatalogHandlerOptions,
  type ServerCardHandlerOptions,
  aiCatalogHandler,
  serverCardHandler,
} from './hono';

describe('serverCardHandler types', () => {
  const card = { name: 'com.example/weather', version: '1.2.0', description: 'Forecasts.' };

  test('takes one URL or a list, and a maxAge, and returns a Hono handler', () => {
    const handler = serverCardHandler({
      ...card,
      resourceUrl: 'https://mcp.example.com/mcp',
      maxAge: 0,
    });
    serverCardHandler({
      ...card,
      resourceUrl: ['https://mcp.example.com/mcp', 'https://mcp.example.dev/mcp'],
    });
    expectTypeOf(handler).parameters.toEqualTypeOf<[Context]>();
    expectTypeOf(handler).returns.toExtend<Response>();
    expectTypeOf<ServerCardHandlerOptions['maxAge']>().toEqualTypeOf<number | undefined>();
  });

  test('rejects generated fields, unknown keys, and request-time callbacks', () => {
    const resourceUrl = 'https://mcp.example.com/mcp';
    // @ts-expect-error remotes are generated
    serverCardHandler({ ...card, resourceUrl, remotes: [] });
    // @ts-expect-error no secret header inputs
    serverCardHandler({ ...card, resourceUrl, headers: [{ name: 'Authorization' }] });
    // @ts-expect-error the card is fixed: no callback per request
    serverCardHandler({ ...card, resourceUrl, card: (c: Context) => c.req.url });
    // @ts-expect-error resourceUrl is required
    serverCardHandler(card);
  });
});

describe('aiCatalogHandler types', () => {
  const entries = [
    { identifier: 'urn:air:example.com:mcp:weather', url: 'https://example.com/mcp/server-card' },
  ];

  test('takes linked entries and a maxAge, and returns a Hono handler', () => {
    const handler = aiCatalogHandler({ entries, maxAge: 0 });
    expectTypeOf(handler).parameters.toEqualTypeOf<[Context]>();
    expectTypeOf(handler).returns.toExtend<Response>();
    expectTypeOf<AICatalogHandlerOptions['maxAge']>().toEqualTypeOf<number | undefined>();
  });

  test('rejects generated fields, a resourceUrl to select by, and request-time callbacks', () => {
    // @ts-expect-error specVersion is generated
    aiCatalogHandler({ entries, specVersion: '1.0' });
    // @ts-expect-error the catalog is fixed: one handler for each origin, not a list to select from
    aiCatalogHandler({ entries, resourceUrl: ['https://mcp.example.com/mcp'] });
    // @ts-expect-error the catalog is fixed: no callback per request
    aiCatalogHandler({ entries: (c: Context) => [{ identifier: 'x', url: c.req.url }] });
    // @ts-expect-error entries are required
    aiCatalogHandler({});
  });
});
