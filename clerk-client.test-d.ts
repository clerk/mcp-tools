import { type MachineAuthObject, createClerkClient } from '@clerk/backend';
import { auth, clerkClient as nextClerkClient } from '@clerk/nextjs/server';
import { describe, expectTypeOf, test } from 'vitest';

import { mcpAuth as expressMcpAuth } from './express';
import { mcpAuth as honoMcpAuth } from './hono';
import { withMcpAuth as nextWithMcpAuth } from './next';
import { type ClerkOAuthAuth, toClerkAuthInfo } from './server';

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

  test('is optional in the Next.js adapter', () => {
    nextWithMcpAuth(handler, { resourceUrl });
  });

  test("toClerkAuthInfo accepts Clerk's own OAuth auth object", async () => {
    toClerkAuthInfo(await auth({ acceptsToken: 'oauth_token' }), 'token');
  });

  test("ClerkOAuthAuth is a part of Clerk's authenticated OAuth auth object", () => {
    expectTypeOf<
      Extract<MachineAuthObject<'oauth_token'>, { isAuthenticated: true }>
    >().toExtend<ClerkOAuthAuth>();
  });

  test('rejects a value without authenticateRequest', () => {
    // @ts-expect-error not a Clerk client
    honoMcpAuth({ resourceUrl, clerkClient: {} });
  });
});
