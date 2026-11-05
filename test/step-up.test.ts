// End to end: the MCP SDK v1 client against a customer tool on MCP SDK 1.x and 2.x servers.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, test, vi } from 'vitest';

import { assertScopes, scopeChallengeFor } from '../server';

const ORIGIN = 'https://mcp.example.com';
const MCP_URL = new URL('/mcp', ORIGIN);
const RESOURCE_METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const TOOL_SCOPES = ['projects:read'];

const TOKENS: Record<string, string[]> = {
  // A scope outside `TOOL_SCOPES`, so a step-up must keep it to prove granted scopes are kept.
  token_profile_only: ['profile'],
  token_full: ['profile', ...TOOL_SCOPES],
};

type ServerKind = 'sdk-v1' | 'sdk-v2';

// Stands in for `verifyClerkToken` after the customer's token check.
function verify(req: Request): AuthInfo | undefined {
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return undefined;
  const scopes = TOKENS[token];
  if (!scopes) return undefined;
  return { token, clientId: 'client_1', scopes, extra: { userId: 'user_1', verifiedBy: 'clerk' } };
}

function mcpRoute(kind: ServerKind, toolCalls: () => void) {
  const listProjects = () => {
    toolCalls();
    return { content: [{ type: 'text' as const, text: 'projects' }] };
  };

  if (kind === 'sdk-v2') {
    const projectsRead = scopeChallengeFor(...TOOL_SCOPES);
    const mcpHandler = createMcpHandler(() => {
      const server = new McpServer({ name: 'customer', version: '0.0.0' });
      server.registerTool(
        'list_projects',
        { description: 'Lists projects', scopeChallenge: projectsRead },
        async (ctx) => {
          assertScopes(ctx, projectsRead);
          return listProjects();
        },
      );
      return server;
    });
    return (req: Request, authInfo: AuthInfo) =>
      mcpHandler.fetch(req, {
        authInfo: { ...authInfo, resourceMetadataUrl: RESOURCE_METADATA_URL },
      });
  }

  // SDK 1.x has no step-up, as behind this package's Express and Hono adapters: only the tool's check applies.
  return async (req: Request, authInfo: AuthInfo) => {
    const server = new McpServerV1({ name: 'customer', version: '0.0.0' });
    server.registerTool('list_projects', { description: 'Lists projects' }, async (extra) => {
      assertScopes(extra, ...TOOL_SCOPES);
      return listProjects();
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req, { authInfo });
    } finally {
      await server.close();
    }
  };
}

function startServer(kind: ServerKind) {
  const toolCalls = vi.fn();
  const route = mcpRoute(kind, toolCalls);

  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path === '/.well-known/oauth-protected-resource/mcp') {
      return Response.json({
        resource: MCP_URL.href,
        authorization_servers: [ORIGIN],
        scopes_supported: ['profile', ...TOOL_SCOPES],
      });
    }
    if (path === '/.well-known/oauth-authorization-server') {
      return Response.json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (path !== '/mcp') return new Response('Not Found', { status: 404 });
    const authInfo = verify(req);
    if (!authInfo) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_METADATA_URL}"` },
      });
    }
    return route(req, authInfo);
  };

  return { fetchImpl, toolCalls };
}

// A client that is already authorized with `token`. A step-up ends at the authorization redirect, which it records.
async function connect(kind: ServerKind, token: string) {
  const { fetchImpl, toolCalls } = startServer(kind);
  const redirects: URL[] = [];
  const authProvider: OAuthClientProvider = {
    redirectUrl: 'http://localhost/callback',
    clientMetadata: { redirect_uris: ['http://localhost/callback'], client_name: 'e2e' },
    clientInformation: () => ({ client_id: 'client_1' }),
    tokens: () => ({ access_token: token, token_type: 'Bearer' }),
    saveTokens: () => {},
    redirectToAuthorization: (url) => {
      redirects.push(url);
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => 'verifier',
  };
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(MCP_URL, { authProvider, fetch: fetchImpl }),
  );
  return { client, redirects, toolCalls };
}

describe.each<ServerKind>(['sdk-v1', 'sdk-v2'])('a customer tool on %s', (kind) => {
  test('runs the tool when the token has the required scopes', async () => {
    const { client, redirects, toolCalls } = await connect(kind, 'token_full');
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(toolCalls).toHaveBeenCalledTimes(1);
    expect(redirects).toHaveLength(0);
  });
});

describe('a customer tool with scopeChallengeFor on MCP SDK 2.x', () => {
  test('steps up a token without the tool scopes, keeping the granted ones', async () => {
    const { client, redirects, toolCalls } = await connect('sdk-v2', 'token_profile_only');
    await expect(client.callTool({ name: 'list_projects', arguments: {} })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(redirects).toHaveLength(1);
    expect(redirects[0]!.origin + redirects[0]!.pathname).toBe(`${ORIGIN}/authorize`);
    expect(redirects[0]!.searchParams.get('scope')).toBe(['profile', ...TOOL_SCOPES].join(' '));
    expect(redirects[0]!.searchParams.get('resource')).toBe(MCP_URL.href);
    expect(toolCalls).not.toHaveBeenCalled();
  });
});

describe('a customer tool with assertScopes on MCP SDK 1.x', () => {
  test('answers a token without the tool scopes with a tool error naming them', async () => {
    const { client, redirects, toolCalls } = await connect('sdk-v1', 'token_profile_only');
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'The token is missing required scopes: projects:read. Reconnect to approve them.',
      },
    ]);
    expect(redirects).toHaveLength(0);
    expect(toolCalls).not.toHaveBeenCalled();
  });
});
