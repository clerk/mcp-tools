// Test-only: connects clients to MCP servers, in memory or over HTTP with OAuth.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import type { vi } from 'vitest';

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

/** The JSON body of the first request that a mocked `fetch` received. */
export function sentBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [, init] = fetchImpl.mock.calls[0]!;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

/**
 * The protected resource and authorization server metadata for an MCP endpoint at `${origin}/mcp`, or undefined
 * for any other path.
 */
export function oauthMetadata(origin: string, path: string, scopes: readonly string[]) {
  if (path === '/.well-known/oauth-protected-resource/mcp') {
    return Response.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: scopes,
    });
  }
  if (path === '/.well-known/oauth-authorization-server') {
    return Response.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  return undefined;
}

/**
 * Connects a client that holds `token`, or none, to `mcpUrl` through `fetch`. Authorization ends at the redirect,
 * which it records.
 */
export function connectOAuthClient(
  mcpUrl: URL,
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>,
  token: string | undefined,
  refreshToken: string | undefined = undefined,
) {
  const redirects: URL[] = [];
  const authProvider: OAuthClientProvider = {
    redirectUrl: 'http://localhost/callback',
    clientMetadata: { redirect_uris: ['http://localhost/callback'], client_name: 'e2e' },
    clientInformation: () => ({ client_id: 'client_1' }),
    tokens: () =>
      token
        ? { access_token: token, token_type: 'Bearer', refresh_token: refreshToken }
        : undefined,
    saveTokens: () => {},
    redirectToAuthorization: (url) => {
      redirects.push(url);
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => 'verifier',
  };
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const connected = client.connect(
    new StreamableHTTPClientTransport(mcpUrl, { authProvider, fetch }),
  );
  return { client, connected, redirects };
}

/** A publishable key whose Frontend API is `clerk.example.com`. */
export const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';

/** An expiry an hour away, in seconds since the epoch, which a custom verifier's result must have. */
export const expiresAt = Math.floor(Date.now() / 1000) + 3600;

/** The request state a mocked `authenticateRequest` resolves to for a valid OAuth token with `scopes`. */
export function clerkAuthenticated(scopes: string[] = []) {
  return {
    isAuthenticated: true,
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: 'oauth_token',
      id: 'oat_1',
      subject: 'user-1',
      getToken: async () => 'token',
      clientId: 'client-1',
      scopes,
      userId: 'user-1',
    }),
  } as const;
}

/** Runs `fn` against an Express app listening on a free port, given the app's origin. */
export async function withListening<T>(app: Express, fn: (baseUrl: string) => Promise<T>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Writes a raw HTTP request, for request lines and headers `fetch` can't send, and resolves the whole response. */
export function sendRaw(baseUrl: string, text: string) {
  const { port } = new URL(baseUrl);
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(text);
    });
    let response = '';
    socket.on('data', (chunk) => (response += chunk.toString()));
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}
