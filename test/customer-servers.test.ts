// End to end: the MCP SDK v1 client against customer MCP servers on SDK 1.x and 2.x, over real HTTP.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  type CustomerServer,
  type CustomerServerKind,
  OWN_TOOL_NAME,
  OWN_TOOL_SCOPES,
  REQUIRED_SCOPES,
  startCustomerServer,
  type TokenName,
  TOKENS,
} from './customer-servers';
import { sentBody, textOf } from './mcp-harness';

const LINK = 'https://app.example.com/v1/tickets/accept?ticket=customer_ticket';

function clerkFetch() {
  return vi.fn<typeof fetch>(async () =>
    Response.json({ object: 'agent_task', agent_task_id: 'agttsk_1', url: LINK }),
  );
}

// A client that is already authorized with `token`. A step-up ends at the authorization redirect, which it records.
function authProvider(token: string) {
  const redirects: URL[] = [];
  const provider: OAuthClientProvider = {
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
  return { provider, redirects };
}

const servers: CustomerServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function connect(kind: CustomerServerKind, token: TokenName) {
  const fetchImpl = clerkFetch();
  const server = await startCustomerServer(kind, fetchImpl);
  servers.push(server);
  const { provider, redirects } = authProvider(server.token(token));
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(server.mcpUrl, { authProvider: provider }),
  );
  return { client, fetchImpl, redirects, server };
}

const callBrowserSession = (client: Client) =>
  client.callTool({ name: 'create_browser_session', arguments: {} });

describe.each<CustomerServerKind>(['v1-route', 'v2-registration', 'express-v2', 'hono-v2'])(
  'create_browser_session on a %s server',
  (kind) => {
    test('creates the link when the token has the required scopes', async () => {
      const { client, fetchImpl } = await connect(kind, 'full');
      const result = await callBrowserSession(client);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain(LINK);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sentBody(fetchImpl)).toMatchObject({
        on_behalf_of: { user_id: 'user_1' },
      });
    });
  },
);

// `express-v2` and `hono-v2` are the README setups: `createMcpAuthClerk` in front of the MCP SDK 2.x adapters.
describe.each<CustomerServerKind>(['v2-registration', 'express-v2', 'hono-v2'])(
  'create_browser_session on a %s server (MCP SDK 2.1+)',
  (kind) => {
    test('steps up a token without the required scopes, keeping the granted ones', async () => {
      const { client, fetchImpl, redirects, server } = await connect(kind, 'profileOnly');
      await expect(callBrowserSession(client)).rejects.toBeInstanceOf(UnauthorizedError);
      expect(redirects).toHaveLength(1);
      expect(redirects[0]!.origin + redirects[0]!.pathname).toBe(`${server.origin}/authorize`);
      // The granted scope comes first, then the missing ones.
      expect(redirects[0]!.searchParams.get('scope')).toBe(
        [...TOKENS.profileOnly.scopes, ...REQUIRED_SCOPES].join(' '),
      );
      expect(redirects[0]!.searchParams.get('resource')).toBe(server.mcpUrl.href);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  },
);

describe.each<CustomerServerKind>(['express-v2', 'hono-v2'])(
  'createMcpAuthClerk on a %s server',
  (kind) => {
    async function post(server: CustomerServer, token?: string) {
      return fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    }

    async function start() {
      const fetchImpl = clerkFetch();
      const server = await startCustomerServer(kind, fetchImpl);
      servers.push(server);
      return { server, fetchImpl };
    }

    test('refuses a token that was issued for another resource with 401', async () => {
      const { server, fetchImpl } = await start();
      // Valid signature and scopes: only the audience differs.
      expect((await post(server, server.token('wrongAudience'))).status).toBe(401);
      expect((await post(server, server.token('full'))).status).toBe(200);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('answers a request without a token with 401 and the metadata URL', async () => {
      const { server } = await start();
      const response = await post(server);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata=${server.origin}/.well-known/oauth-protected-resource/mcp`,
      );
    });

    test('refuses a token that is not a valid access token with 401', async () => {
      const { server } = await start();
      expect((await post(server, 'not_a_token')).status).toBe(401);
    });
  },
);

describe('create_browser_session on a v1-route server (MCP SDK 1.x)', () => {
  test('answers a token without the required scopes with the tool error and no step-up', async () => {
    const { client, fetchImpl, redirects } = await connect('v1-route', 'profileOnly');
    const result = await callBrowserSession(client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      `The token is missing required scopes: ${REQUIRED_SCOPES.join(', ')}`,
    );
    expect(redirects).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a customer tool with scopeChallengeFor on a v2-own-tool server (MCP SDK 2.1+)', () => {
  test('steps up a token without the tool scopes, keeping the granted ones', async () => {
    const { client, fetchImpl, redirects } = await connect('v2-own-tool', 'profileOnly');
    await expect(client.callTool({ name: OWN_TOOL_NAME, arguments: {} })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(redirects).toHaveLength(1);
    expect(redirects[0]!.searchParams.get('scope')).toBe(
      [...TOKENS.profileOnly.scopes, ...OWN_TOOL_SCOPES].join(' '),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
