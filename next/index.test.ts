import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { protectedResourceHandler, protectedResourceHandlerClerk } from './index';

const METADATA_ROOT = 'https://mcp.example.com/.well-known/oauth-protected-resource';

describe.each([
  [
    'protectedResourceHandler',
    () => protectedResourceHandler({ authServerUrl: 'https://as.test' }),
  ],
  ['protectedResourceHandlerClerk', () => protectedResourceHandlerClerk()],
])('%s', (_name, createHandler) => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  test.each([
    ['/mcp', 'https://mcp.example.com/mcp'],
    ['/mcp/', 'https://mcp.example.com/mcp'],
    ['', 'https://mcp.example.com'],
    ['/', 'https://mcp.example.com'],
  ])('describes the resource for the metadata route suffix %j', async (suffix, resource) => {
    const res = createHandler()(new Request(`${METADATA_ROOT}${suffix}`));

    expect((await res.json()).resource).toBe(resource);
  });
});
