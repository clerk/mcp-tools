import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { registerSubmitFeedbackTool, submitFeedback } from './feedback';

const input = {
  goal: 'Create a user',
  attempted: 'Called create_user',
  outcome: 'blocked' as const,
  issue: 'create_user returned 500',
};

const stored = { id: 'fbk_1', created_at: '2026-10-21T00:00:00.000Z' };

function storedResponse() {
  return Response.json(stored, { status: 201 });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [, init] = fetchImpl.mock.calls[0]!;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function connect(fetchImpl: typeof fetch, authInfo?: AuthInfo) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSubmitFeedbackTool(server, {
    secretKey: 'sk_test_123',
    apiUrl: 'https://api.clerk.test',
    fetch: fetchImpl,
  });
  const client = new Client({ name: 'client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  if (authInfo) {
    const handleMessage = serverTransport.onmessage;
    serverTransport.onmessage = (message, extra) =>
      handleMessage?.(message, { ...extra, authInfo });
  }
  await client.connect(clientTransport);
  return client;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('submitFeedback', () => {
  test('posts to the Backend API with the secret key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());

    const result = await submitFeedback(input, {
      secretKey: 'sk_test_123',
      apiUrl: 'https://api.clerk.test',
      fetch: fetchImpl,
    });

    expect(result).toEqual(stored);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.clerk.test/v1/agent_feedback');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_test_123');
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  test('rejects a successful response that does not describe the stored feedback', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ created_at: 'x' }, { status: 201 }),
    );

    await expect(
      submitFeedback(input, { secretKey: 'sk_test_123', fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'FeedbackSubmissionError', status: 201 });
  });
});

describe('registerSubmitFeedbackTool', () => {
  test('requires a secret key at registration', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    expect(() => registerSubmitFeedbackTool(server, { secretKey: '' })).toThrow(/secretKey/);
  });

  test('lists the tool with its input schema', async () => {
    const client = await connect(vi.fn<typeof fetch>());

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['submit_feedback']);
    expect(tools[0]!.inputSchema.required).toEqual(['goal', 'attempted', 'outcome', 'issue']);
  });

  test('returns the stored feedback id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl);

    const result = await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ feedback_id: 'fbk_1', received: true });
  });

  test('attaches the Clerk user and OAuth client from verifyClerkToken auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl, {
      token: 'oat_test',
      clientId: 'client_123',
      scopes: ['profile'],
      extra: { userId: 'user_123', verifiedBy: 'clerk' },
    });

    await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(sentBody(fetchImpl)).toMatchObject({
      user_id: 'user_123',
      oauth_client_id: 'client_123',
    });
  });

  test('does not forward identity from other auth providers or from the agent', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl, {
      token: 'external',
      clientId: 'external-client',
      scopes: [],
      extra: { userId: 'user_01HEXTERNALPROVIDER' },
    });

    await client.callTool({
      name: 'submit_feedback',
      arguments: { ...input, user_id: 'user_spoofed', oauth_client_id: 'client_spoofed' },
    });

    const body = sentBody(fetchImpl);
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('oauth_client_id');
  });

  test('tells the agent not to retry when the API rejects the feedback', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ errors: [] }, { status: 429 }),
    );
    const client = await connect(fetchImpl);

    const result = await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Do not retry');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('status 429'));
  });

  test('never logs the error message of a failed request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('request failed: Bearer sk_test_123');
    });
    const client = await connect(fetchImpl);

    const result = await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(result.isError).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('(TypeError)'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('sk_test_123');
  });

  test('tells the agent not to retry when a stored response is malformed', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ created_at: 'x' }, { status: 201 }),
    );
    const client = await connect(fetchImpl);

    const result = await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Do not retry');
  });

  test('rejects invalid input before calling the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: 'submit_feedback',
      arguments: { ...input, outcome: 'fine' },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
