// End to end: the MCP SDK v1 client against a customer tool on an MCP SDK 2.x server.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

import { mcpAuth } from '../hono';
import { requireAdditionalScopes } from '../server';

const ORIGIN = 'https://mcp.example.com';
const MCP_URL = new URL('/mcp', ORIGIN);
const RESOURCE_METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const TOOL_SCOPES = ['projects:read'] as const;

const TOKENS: Record<string, string[]> = {
  // A scope outside `TOOL_SCOPES`, so a step-up must keep it to prove granted scopes are kept.
  token_profile_only: ['profile'],
  token_full: ['profile', ...TOOL_SCOPES],
};

// Stands in for `toClerkAuthInfo` after the customer's token check.
function verify(req: Request): AuthInfo | undefined {
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return undefined;
  const scopes = TOKENS[token];
  if (!scopes) return undefined;
  return { token, clientId: 'client_1', scopes, extra: { userId: 'user_1', verifiedBy: 'clerk' } };
}

function startServer() {
  const toolCalls = vi.fn();
  const tokenRequests: URLSearchParams[] = [];
  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer({ name: 'customer', version: '0.0.0' });
    server.registerTool(
      'list_projects',
      { description: 'Lists projects', scopeChallenge: requireAdditionalScopes(...TOOL_SCOPES) },
      async () => {
        toolCalls();
        return { content: [{ type: 'text' as const, text: 'projects' }] };
      },
    );
    return server;
  });

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
    if (path === '/token') {
      const params = new URLSearchParams(await req.text());
      tokenRequests.push(params);
      // A refresh grant keeps the original scopes, so the new token is no better than the old one.
      return Response.json({
        access_token: 'token_profile_only',
        token_type: 'Bearer',
        refresh_token: params.get('refresh_token'),
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
    return mcpHandler.fetch(req, {
      authInfo: { ...authInfo, resourceMetadataUrl: RESOURCE_METADATA_URL },
    });
  };

  return { fetchImpl, toolCalls, tokenRequests };
}

// A client that is already authorized with `token`. A step-up ends at the authorization redirect, which it records.
async function connect(token: string, refreshToken?: string) {
  const { fetchImpl, toolCalls, tokenRequests } = startServer();
  const redirects: URL[] = [];
  const authProvider: OAuthClientProvider = {
    redirectUrl: 'http://localhost/callback',
    clientMetadata: { redirect_uris: ['http://localhost/callback'], client_name: 'e2e' },
    clientInformation: () => ({ client_id: 'client_1' }),
    tokens: () => ({ access_token: token, token_type: 'Bearer', refresh_token: refreshToken }),
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
  return { client, redirects, toolCalls, tokenRequests };
}

describe('a customer tool with requireAdditionalScopes on MCP SDK 2.x', () => {
  test('runs the tool when the token has the required scopes', async () => {
    const { client, redirects, toolCalls } = await connect('token_full');
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(toolCalls).toHaveBeenCalledTimes(1);
    expect(redirects).toHaveLength(0);
  });

  test('steps up a token without the tool scopes, keeping the granted ones', async () => {
    const { client, redirects, toolCalls } = await connect('token_profile_only');
    await expect(client.callTool({ name: 'list_projects', arguments: {} })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(redirects).toHaveLength(1);
    expect(redirects[0]!.origin + redirects[0]!.pathname).toBe(`${ORIGIN}/authorize`);
    expect(redirects[0]!.searchParams.get('scope')).toBe(['profile', ...TOOL_SCOPES].join(' '));
    expect(redirects[0]!.searchParams.get('resource')).toBe(MCP_URL.href);
    expect(toolCalls).not.toHaveBeenCalled();
  });

  // The MCP SDK 1.x client refreshes instead of redirecting, so it never reaches consent. Fixed on the
  // SDK's main branch, not on 1.x: https://github.com/modelcontextprotocol/typescript-sdk/issues/2255
  test('dead-ends on the SDK 1.x client when it holds a refresh token', async () => {
    const { client, redirects, toolCalls, tokenRequests } = await connect(
      'token_profile_only',
      'refresh_1',
    );
    await expect(client.callTool({ name: 'list_projects', arguments: {} })).rejects.toThrow(
      /after trying upscoping/,
    );
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.get('grant_type')).toBe('refresh_token');
    expect(redirects).toHaveLength(0);
    expect(toolCalls).not.toHaveBeenCalled();
  });
});

// The middleware's 403 asks for the tool's scopes too when they are in `challengeScopes`, so one reauthorization with
// its `scope` is enough: the tool's own `requireAdditionalScopes` check passes, with no second 403.
describe('a requireAdditionalScopes tool behind mcpAuth that lists its scopes in challengeScopes', () => {
  // A token `scoped:<scopes>` grants the comma-separated scopes, standing in for the grant a reauthorization returns.
  function verifyScoped(token: string): AuthInfo | undefined {
    const scopes = /^scoped:(.*)$/.exec(token)?.[1];
    if (scopes === undefined) return undefined;
    return { token, clientId: 'client_1', scopes: scopes.split(',').filter(Boolean) };
  }

  function startMiddlewareServer() {
    const toolCalls = vi.fn();
    const mcpHandler = createMcpHandler(() => {
      const server = new McpServer({ name: 'customer', version: '0.0.0' });
      server.registerTool(
        'list_projects',
        { description: 'Lists projects', scopeChallenge: requireAdditionalScopes(...TOOL_SCOPES) },
        async () => {
          toolCalls();
          return { content: [{ type: 'text' as const, text: 'projects' }] };
        },
      );
      return server;
    });
    const app = new Hono();
    app.all(
      '/mcp',
      mcpAuth({
        verifyToken: verifyScoped,
        requiredScopes: ['profile', 'email'],
        challengeScopes: [...TOOL_SCOPES],
      }),
      (c) => mcpHandler.fetch(c.req.raw, { authInfo: c.get('mcpAuth') }),
    );

    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const path = new URL(req.url).pathname;
      if (path === '/.well-known/oauth-protected-resource/mcp') {
        return Response.json({
          resource: MCP_URL.href,
          authorization_servers: [ORIGIN],
          scopes_supported: ['profile', 'email', ...TOOL_SCOPES],
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
      return app.request(req);
    };

    return { fetchImpl, toolCalls };
  }

  async function connectTo(server: ReturnType<typeof startMiddlewareServer>, token: string) {
    const redirects: URL[] = [];
    const statuses: number[] = [];
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
    const fetch = async (input: string | URL, init?: RequestInit) => {
      const res = await server.fetchImpl(input, init);
      if (new URL(input).pathname === '/mcp') statuses.push(res.status);
      return res;
    };
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    const connected = client.connect(
      new StreamableHTTPClientTransport(MCP_URL, { authProvider, fetch }),
    );
    return { client, connected, redirects, statuses };
  }

  test('runs the tool after one reauthorization with the 403 scope', async () => {
    const server = startMiddlewareServer();

    const first = await connectTo(server, 'scoped:profile');
    await expect(first.connected).rejects.toBeInstanceOf(UnauthorizedError);
    expect(first.statuses).toEqual([403]);
    expect(first.redirects).toHaveLength(1);
    const scope = first.redirects[0]!.searchParams.get('scope');

    const second = await connectTo(server, `scoped:${scope?.replaceAll(' ', ',')}`);
    await second.connected;
    const result = await second.client.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(server.toolCalls).toHaveBeenCalledTimes(1);
    expect(second.redirects).toHaveLength(0);
    expect(second.statuses).not.toContain(403);
    // The granted scopes first, so the new grant keeps the old access
    expect(scope).toBe(['profile', 'email', ...TOOL_SCOPES].join(' '));
  });
});
