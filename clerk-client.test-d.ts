import { createClerkClient } from '@clerk/backend';
import { auth, clerkClient as nextClerkClient } from '@clerk/nextjs/server';
import { describe, test } from 'vitest';

import { mcpAuth as expressMcpAuth } from './express';
import { mcpAuth as honoMcpAuth } from './hono';
import { withMcpAuth as nextWithMcpAuth } from './next';
import { toClerkAuthInfo } from './server';

describe('the clerkClient option', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  const clerkClient = createClerkClient({ secretKey: 'sk_test_types' });
  const handler = () => new Response();

  test("accepts the app's own client from createClerkClient in every adapter", () => {
    expressMcpAuth({ resourceUrl, clerkClient });
    honoMcpAuth({ resourceUrl, clerkClient });
    nextWithMcpAuth(handler, { resourceUrl, clerkClient });
  });

  test('accepts clerkClient from @clerk/nextjs/server in the Next.js adapter', () => {
    nextWithMcpAuth(handler, { resourceUrl, clerkClient: nextClerkClient });
  });

  test('is required in the Next.js adapter', () => {
    // @ts-expect-error no clerkClient
    nextWithMcpAuth(handler, { resourceUrl });
  });

  test("toClerkAuthInfo accepts Clerk's own OAuth auth object", async () => {
    toClerkAuthInfo(await auth({ acceptsToken: 'oauth_token' }), 'token');
  });

  test('rejects a value without authenticateRequest', () => {
    // @ts-expect-error not a Clerk client
    honoMcpAuth({ resourceUrl, clerkClient: {} });
  });
});
