import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { MessageExtraInfo, RequestInfo } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  submitFeedback,
  type SubmitFeedbackTool,
  submitFeedbackTool,
  type SubmitFeedbackToolOptions,
} from './feedback';

const input = {
  kind: 'broken' as const,
  task: 'Create a user',
  description: 'Called create_user with an email. It returned a 500 error.',
  impact: 'blocked' as const,
};

const report = { kind: 'broken', task: 'Create a user', description: 'Called create_user.' };

const stored = { id: 'fbk_1', created_at: '2026-10-21T00:00:00.000Z' };

function storedResponse() {
  return Response.json(stored, { status: 201 });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [, init] = fetchImpl.mock.calls[0]!;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

type ConnectOptions = {
  authInfo?: AuthInfo;
  requestInfo?: RequestInfo;
  server?: SubmitFeedbackToolOptions['server'];
};

// Customers spread the tuple into registerTool (checked against the packed package). Compiling feedback.ts from
// source infers much deeper zod types than its declarations, so here the generics are passed explicitly.
function register(server: McpServer, [name, config, callback]: SubmitFeedbackTool) {
  server.registerTool<typeof config.outputSchema, typeof config.inputSchema>(
    name,
    config,
    callback,
  );
}

async function connect(fetchImpl: typeof fetch, options: ConnectOptions = {}) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  register(
    server,
    submitFeedbackTool({
      secretKey: 'sk_test_123',
      apiUrl: 'https://api.clerk.test',
      fetch: fetchImpl,
      server: 'server' in options ? options.server : { name: 'acme-mcp', version: '1.2.0' },
    }),
  );
  const client = new Client({ name: 'claude-code', version: '2.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const handleMessage = serverTransport.onmessage as
    | ((message: unknown, extra?: MessageExtraInfo) => void)
    | undefined;
  serverTransport.onmessage = (message, extra) =>
    handleMessage?.(message, {
      ...extra,
      authInfo: options.authInfo,
      requestInfo: options.requestInfo,
    });
  await client.connect(clientTransport);
  return client;
}

function clientInfoMeta(name: string, version: string) {
  return { 'io.modelcontextprotocol/clientInfo': { name, version } };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('submitFeedback', () => {
  test('posts to the Backend API with the secret key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());

    const result = await submitFeedback(report, {
      secretKey: 'sk_test_123',
      apiUrl: 'https://api.clerk.test',
      fetch: fetchImpl,
    });

    expect(result).toEqual(stored);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.clerk.test/v1/feedback');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_test_123');
    expect(JSON.parse(String(init?.body))).toEqual(report);
  });

  test('gives up on the request after 10 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());

    await submitFeedback(report, { secretKey: 'sk_test_123', fetch: fetchImpl });

    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBe(timeout.mock.results[0]!.value);
    timeout.mockRestore();
  });

  test('rejects a successful response that does not describe the stored feedback', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ created_at: 'x' }, { status: 201 }),
    );

    await expect(
      submitFeedback(report, { secretKey: 'sk_test_123', fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: 'FeedbackSubmissionError', status: 201 });
  });
});

describe('submitFeedbackTool', () => {
  test('requires a secret key', () => {
    expect(() => submitFeedbackTool({ secretKey: '' })).toThrow(/secretKey/);
    expect(() => submitFeedbackTool({ secretKey: '  ' })).toThrow(/secretKey/);
  });

  test('lists the tool with its input schema', async () => {
    const client = await connect(vi.fn<typeof fetch>());

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['submit_feedback']);
    expect(tools[0]!.inputSchema.required).toEqual(['kind', 'task', 'description', 'impact']);
  });

  test('returns the stored feedback id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl);

    const result = await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ feedback_id: 'fbk_1', received: true });
  });

  test('sends the configured server as source and the client info sent with the request as reporter', async () => {
    // GIVEN a request that carries its client info and also has a User-Agent
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl, {
      requestInfo: { headers: { 'user-agent': 'node' }, url: new URL('https://mcp.acme.test/mcp') },
    });

    // WHEN
    await client.callTool({
      name: 'submit_feedback',
      arguments: {
        ...input,
        operation: 'mcp__acme_mcp__create_user, mcp__acme_mcp__list_users',
        error: 'HTTP 500',
      },
      _meta: clientInfoMeta('cursor', '1.7.0'),
    });

    // THEN the request's client info wins over the User-Agent, and the server option over the host
    expect(sentBody(fetchImpl)).toEqual({
      ...input,
      operation: 'create_user, list_users',
      error: 'HTTP 500',
      source: { type: 'mcp', name: 'acme-mcp', version: '1.2.0' },
      reporter: { type: 'agent', name: 'cursor', version: '1.7.0' },
    });
  });

  test('names the agent from the User-Agent product when the request has no client info', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl, {
      requestInfo: { headers: { 'user-agent': 'claude-code/2.1.0 (darwin; arm64)' } },
    });

    await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(sentBody(fetchImpl).reporter).toEqual({
      type: 'agent',
      name: 'claude-code',
      version: '2.1.0',
    });
  });

  test('names no agent when the client identified itself only during initialize', async () => {
    // GIVEN a stdio-style connection: no per-request client info and no HTTP headers
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl);

    await client.callTool({ name: 'submit_feedback', arguments: input });

    // THEN the initialize client info ("claude-code") is not used
    expect(sentBody(fetchImpl).reporter).toEqual({ type: 'agent' });
  });

  test("defaults the source name to the request's host", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl, {
      server: undefined,
      requestInfo: { headers: {}, url: new URL('https://mcp.acme.test/mcp') },
    });

    await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(sentBody(fetchImpl).source).toEqual({ type: 'mcp', name: 'mcp.acme.test' });
  });

  test('caps agent and server labels at the Backend API limits', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl, {
      server: { name: 's'.repeat(150), version: 'v'.repeat(80) },
    });

    await client.callTool({
      name: 'submit_feedback',
      arguments: input,
      _meta: clientInfoMeta('a'.repeat(150), '1'.repeat(80)),
    });

    expect(sentBody(fetchImpl)).toMatchObject({
      source: { name: 's'.repeat(100), version: 'v'.repeat(50) },
      reporter: { name: 'a'.repeat(100), version: '1'.repeat(50) },
    });
  });

  test('attaches the Clerk user and OAuth client from verifyClerkToken auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl, {
      authInfo: {
        token: 'oat_test',
        clientId: 'client_123',
        scopes: ['profile'],
        extra: { userId: 'user_123', verifiedBy: 'clerk' },
      },
    });

    await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(sentBody(fetchImpl)).toMatchObject({
      user_id: 'user_123',
      client_id: 'client_123',
    });
  });

  test('does not forward identity from other auth providers or from the agent', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => storedResponse());
    const client = await connect(fetchImpl, {
      authInfo: {
        token: 'external',
        clientId: 'external-client',
        scopes: [],
        extra: { userId: 'user_01HEXTERNALPROVIDER' },
      },
    });

    await client.callTool({
      name: 'submit_feedback',
      arguments: { ...input, user_id: 'user_spoofed', client_id: 'client_spoofed' },
    });

    const body = sentBody(fetchImpl);
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('client_id');
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

  test('tells the agent to continue when the API does not answer in time', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const client = await connect(fetchImpl);

    const result = await client.callTool({ name: 'submit_feedback', arguments: input });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('continue with the task');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('(TimeoutError)'));
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
      arguments: { ...input, impact: 'fine' },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
