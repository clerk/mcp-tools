import { describe, test } from 'vitest';

import { generateProtectedResourceMetadata } from './server';

describe('generateProtectedResourceMetadata types', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  const publishableKey = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
  const authServerUrl = 'https://auth.example.com';

  test('accepts a publishable key or an authorization server URL', () => {
    generateProtectedResourceMetadata({ resourceUrl, publishableKey });
    generateProtectedResourceMetadata({ resourceUrl, authServerUrl });
    generateProtectedResourceMetadata({
      resourceUrl,
      publishableKey,
      properties: { resource_name: 'Example' },
    });
    generateProtectedResourceMetadata({
      resourceUrl,
      authServerUrl,
      properties: { resource_name: 'Example' },
    });
  });

  test('rejects both a publishable key and an authorization server URL', () => {
    // @ts-expect-error both
    generateProtectedResourceMetadata({ resourceUrl, publishableKey, authServerUrl });
  });

  test('rejects neither a publishable key nor an authorization server URL', () => {
    // @ts-expect-error neither
    generateProtectedResourceMetadata({ resourceUrl });
  });
});
