import type { Context } from 'hono';
import { describe, expectTypeOf, test } from 'vitest';

import {
  type AICatalogHandlerOptions,
  type ServerCardHandlerOptions,
  aiCatalogHandler,
  serverCardHandler,
} from './hono';
import * as next from './next';

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

describe('Next.js discovery route handler types', () => {
  const card = { name: 'com.example/weather', version: '1.2.0', description: 'Forecasts.' };
  const entries = [
    { identifier: 'urn:air:example.com:mcp:weather', url: 'https://example.com/mcp/server-card' },
  ];

  test('take the shared options and return a route handler of a Request', () => {
    const cardRoute = next.serverCardHandler({
      ...card,
      resourceUrl: ['https://mcp.example.com/mcp', 'https://mcp.example.dev/mcp'],
      maxAge: 0,
    });
    const catalogRoute = next.aiCatalogHandler({ entries, maxAge: 60 });
    expectTypeOf(cardRoute).toEqualTypeOf<(req: Request) => Response>();
    expectTypeOf(catalogRoute).toEqualTypeOf<(req: Request) => Response>();
    expectTypeOf<next.ServerCardHandlerOptions>().toEqualTypeOf<ServerCardHandlerOptions>();
    expectTypeOf<next.AICatalogHandlerOptions>().toEqualTypeOf<AICatalogHandlerOptions>();
  });

  test('reject generated fields, unknown keys, and request-time callbacks', () => {
    const resourceUrl = 'https://mcp.example.com/mcp';
    // @ts-expect-error remotes are generated
    next.serverCardHandler({ ...card, resourceUrl, remotes: [] });
    // @ts-expect-error the card is fixed: no callback per request
    next.serverCardHandler({ ...card, resourceUrl, card: (req: Request) => req.url });
    // @ts-expect-error resourceUrl is required
    next.serverCardHandler(card);
    // @ts-expect-error specVersion is generated
    next.aiCatalogHandler({ entries, specVersion: '1.0' });
    // @ts-expect-error the catalog is fixed: one handler for each origin, not a list to select from
    next.aiCatalogHandler({ entries, resourceUrl: [resourceUrl] });
    // @ts-expect-error entries are required
    next.aiCatalogHandler({});
  });
});
