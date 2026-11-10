import { createClerkClient } from '@clerk/backend';
import { describe, test } from 'vitest';

import { mcpAuthClerk as expressMcpAuthClerk } from './express';
import { mcpAuthClerk as honoMcpAuthClerk } from './hono';
import { mcpAuthClerk as nextMcpAuthClerk } from './next';

describe('the clerkClient option', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  const clerkClient = createClerkClient({ secretKey: 'sk_test_types' });

  test("accepts the app's own client from createClerkClient in every adapter", () => {
    expressMcpAuthClerk({ resourceUrl, clerkClient });
    honoMcpAuthClerk({ resourceUrl, clerkClient });
    nextMcpAuthClerk({ resourceUrl, clerkClient });
  });

  test('rejects a value without authenticateRequest', () => {
    // @ts-expect-error not a Clerk client
    honoMcpAuthClerk({ resourceUrl, clerkClient: {} });
  });
});
