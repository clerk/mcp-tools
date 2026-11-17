import { describe, expectTypeOf, test } from 'vitest';

import {
  type ClerkAuthInfo,
  type ClerkOAuthAuth,
  type ServerCard,
  generateProtectedResourceMetadata,
  generateServerCard,
} from './server';

describe('generateProtectedResourceMetadata types', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  const publishableKey = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
  const authServerUrl = 'https://auth.example.com';

  test('accepts a publishable key or an authorization server URL', () => {
    generateProtectedResourceMetadata({ resourceUrl, publishableKey });
    generateProtectedResourceMetadata({
      resourceUrl,
      authServerUrl,
      properties: { resource_name: 'Example' },
    });
  });

  test('rejects both or neither of a publishable key and an authorization server URL', () => {
    // @ts-expect-error both
    generateProtectedResourceMetadata({ resourceUrl, publishableKey, authServerUrl });
    // @ts-expect-error neither
    generateProtectedResourceMetadata({ resourceUrl });
  });
});

describe('ClerkAuthInfo types', () => {
  test('leaves extra.auth optional, so auth info built by hand for 0.9.0 still type-checks', () => {
    const built: ClerkAuthInfo = {
      token: 't',
      clientId: 'client_1',
      scopes: [],
      extra: { userId: 'user_1', verifiedBy: 'clerk' },
    };
    expectTypeOf(built.extra.auth).toEqualTypeOf<ClerkOAuthAuth | undefined>();
  });
});

describe('generateServerCard types', () => {
  const required = {
    name: 'com.example/weather',
    version: '1.2.0',
    description: 'Forecasts.',
    resourceUrl: 'https://mcp.example.com/mcp',
  };

  test('takes the supported fields and returns a read-only card', () => {
    const card = generateServerCard({
      ...required,
      title: 'Weather',
      icons: [{ src: 'https://example.com/icon.png', theme: 'dark' }],
      _meta: { 'com.example/tier': { plan: 'free', limits: [1, null] } },
    });
    expectTypeOf(card).toEqualTypeOf<ServerCard>();
    expectTypeOf(card.remotes[0].type).toEqualTypeOf<'streamable-http'>();
    // @ts-expect-error the card is read-only
    card.name = 'com.example/other';
  });

  test('rejects generated fields, unknown keys, a URL list, and _meta that is not JSON', () => {
    // @ts-expect-error $schema is generated
    generateServerCard({ ...required, $schema: 'https://example.com/schema.json' });
    // @ts-expect-error remotes are generated
    generateServerCard({ ...required, remotes: [] });
    // @ts-expect-error not a supported field
    generateServerCard({ ...required, tools: [] });
    // @ts-expect-error one URL: a list is for the handlers
    generateServerCard({ ...required, resourceUrl: ['https://mcp.example.com/mcp'] });
    // @ts-expect-error a function is not JSON
    generateServerCard({ ...required, _meta: { 'com.example/x': () => 1 } });
    // @ts-expect-error a theme is light or dark
    generateServerCard({ ...required, icons: [{ src: 'i.png', theme: 'blue' }] });
  });
});
