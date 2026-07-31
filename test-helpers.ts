import { McpServer } from '@modelcontextprotocol/server';

export const mcpHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

export const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
});

export const discoverBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'server/discover',
  params: {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
});

export const discoverHeaders = {
  'MCP-Protocol-Version': '2026-07-28',
  'Mcp-Method': 'server/discover',
};

export function createMcpServer() {
  return new McpServer({ name: 'test-server', version: '1.0.0' });
}

// The legacy leg answers over SSE while the modern leg answers with a plain
// JSON body — normalize both to the contained JSON-RPC message.
export async function readJsonRpcMessage(res: Response) {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();

  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) throw new Error(`No data line in SSE response: ${text}`);
    return JSON.parse(dataLine.slice('data: '.length));
  }

  return JSON.parse(text);
}
