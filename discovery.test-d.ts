import type { Context } from 'hono';
import { describe, expectTypeOf, test } from 'vitest';

import { type ServerCardHandlerOptions, serverCardHandler } from './hono';

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
