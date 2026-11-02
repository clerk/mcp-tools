import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler, McpServer as McpServerV2 } from '@modelcontextprotocol/server';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { scopeChallenge, type ToolScopes } from './server';

const RESOURCE_METADATA_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

const authInfo: AuthInfo = { token: 't', clientId: 'client_1', scopes: ['profile', 'email'] };

const toolScopes: ToolScopes = {
  create_browser_session: ['profile', 'user:org:read'],
  whoami: ['profile'],
  a: ['x', 'y'],
  b: ['y', 'z'],
};

function toolCall(name: unknown, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } };
}

function challenge(body: unknown) {
  return scopeChallenge({ body, authInfo, toolScopes, resourceMetadataUrl: RESOURCE_METADATA_URL });
}

function challengedScopes(body: unknown) {
  return challenge(body)
    ?.headers.get('WWW-Authenticate')
    ?.match(/scope="([^"]*)"/)?.[1];
}

describe('scopeChallenge', () => {
  test('returns a 403 step-up challenge with the granted scopes first, then the missing ones', async () => {
    const response = challenge(toolCall('create_browser_session'));
    expect(response?.status).toBe(403);
    expect(response?.headers.get('WWW-Authenticate')).toBe(
      `Bearer error="insufficient_scope", scope="profile email user:org:read", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
    expect(await response?.json()).toEqual({ error: 'Forbidden' });
  });

  test('reads every tools/call message in a batch', () => {
    const batch = [
      toolCall('whoami', 1),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      toolCall('create_browser_session', 3),
    ];
    expect(challengedScopes(batch)).toBe('profile email user:org:read');
  });

  test('lists each missing scope once', () => {
    expect(challengedScopes([toolCall('a', 1), toolCall('b', 2)])).toBe('profile email x y z');
  });

  test.each([
    ['a tool whose scopes the token has', toolCall('whoami')],
    ['a tool that is not listed', toolCall('unknown_tool')],
    ['a request that calls no tool', { jsonrpc: '2.0', id: 1, method: 'initialize' }],
    ['no body', undefined],
    ['a string', 'tools/call'],
    ['a tools/call without params', { jsonrpc: '2.0', id: 1, method: 'tools/call' }],
    ['a non-string tool name', toolCall(42)],
    ['null entries', [null, 7]],
  ])('lets %s through', (_name, body) => {
    expect(challenge(body)).toBeUndefined();
  });

  // A custom JavaScript verifier can return auth info without `scopes`.
  test.each([
    ['no scopes', { token: 't', clientId: 'client_1' }],
    ['non-array scopes', { token: 't', clientId: 'client_1', scopes: 'profile' }],
  ])('treats auth info with %s as granting none', (_name, info) => {
    const response = scopeChallenge({
      body: toolCall('whoami'),
      authInfo: info as unknown as AuthInfo,
      toolScopes,
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });
    expect(response?.status).toBe(403);
    expect(response?.headers.get('WWW-Authenticate')).toContain('scope="profile"');
  });
});

describe('scopeChallenge toolScopes validation', () => {
  test.each([
    ['a space', 'profile email'],
    ['a quote', 'a"b'],
    ['a backslash', 'a\\b'],
    ['a control character', 'a\nb'],
    ['an empty string', ''],
  ])('throws for a scope with %s', (_name, scope) => {
    expect(() =>
      scopeChallenge({
        body: toolCall('whoami'),
        authInfo,
        toolScopes: { whoami: [scope] },
        resourceMetadataUrl: RESOURCE_METADATA_URL,
      }),
    ).toThrow(/^Clerk error: scopeChallenge toolScopes/);
  });

  test('accepts scope tokens such as profile, user:org:read and https://example.com/a', () => {
    expect(() =>
      scopeChallenge({
        body: toolCall('whoami'),
        authInfo,
        toolScopes: { whoami: ['profile', 'user:org:read', 'https://example.com/a'] },
        resourceMetadataUrl: RESOURCE_METADATA_URL,
      }),
    ).not.toThrow();
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'treats the inherited object key %j as a tool that needs no scopes',
    (name) => {
      expect(challenge(toolCall(name))).toBeUndefined();
    },
  );
});

describe('scopeChallenge in front of an MCP SDK v2 handler', () => {
  function route(tool: () => void) {
    const handler = createMcpHandler(() => {
      const mcp = new McpServerV2({ name: 'test', version: '0.0.0' });
      mcp.registerTool('whoami', { inputSchema: z.object({}) }, () => {
        tool();
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      return mcp;
    });
    // The route reads the body once, runs the challenge, then hands the same body to the handler.
    return async (request: Request, auth: AuthInfo) => {
      const body: unknown = await request.json();
      const response = scopeChallenge({
        body,
        authInfo: auth,
        toolScopes: { whoami: ['profile'] },
        resourceMetadataUrl: RESOURCE_METADATA_URL,
      });
      return response ?? handler.fetch(request, { authInfo: auth, parsedBody: body });
    };
  }

  function post() {
    return new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(toolCall('whoami')),
    });
  }

  test('challenges before the v2 handler runs the tool', async () => {
    const tool = vi.fn();
    const response = await route(tool)(post(), { ...authInfo, scopes: ['email'] });
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain('scope="email profile"');
    expect(tool).not.toHaveBeenCalled();
  });

  test('lets the v2 handler run the tool with the parsed body when the token has the scopes', async () => {
    const tool = vi.fn();
    const response = await route(tool)(post(), authInfo);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('ok');
    expect(tool).toHaveBeenCalledOnce();
  });
});
