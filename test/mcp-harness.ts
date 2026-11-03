// Test-only: connects a client to one tool tuple over an in-memory transport.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

/**
 * Registers a tool with `register`, as customers do with `server.registerTool(...tool)`, and connects a client.
 * Each request carries `requestExtra`, as an HTTP transport would add it.
 */
export async function connectTool(
  register: (server: McpServer) => void,
  requestExtra: Pick<MessageExtraInfo, 'authInfo' | 'requestInfo'> = {},
) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  register(server);
  const client = new Client({ name: 'claude-code', version: '2.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const handleMessage = serverTransport.onmessage as
    | ((message: unknown, extra?: MessageExtraInfo) => void)
    | undefined;
  serverTransport.onmessage = (message, extra) =>
    handleMessage?.(message, { ...extra, ...requestExtra });
  await client.connect(clientTransport);
  return client;
}

export function textOf(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as { type: string; text: string }[];
  return content.map((part) => part.text).join('\n');
}
