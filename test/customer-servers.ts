// Test-only: MCP servers set up the way a customer would, on MCP SDK 1.x and 2.x, served over real HTTP.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpHandler, McpServer as McpServerV2 } from '@modelcontextprotocol/server';

import { createBrowserSessionTool } from '../create-browser-session';
import { requireAdditionalScopes } from '../server';

export const REQUIRED_SCOPES = ['email', 'user:org:read'] as const;

export const OWN_TOOL_NAME = 'list_projects';
export const OWN_TOOL_SCOPES = ['projects:read'] as const;

/** Bearer tokens the servers accept, and the scopes each one grants. */
export const TOKENS = {
  // A scope outside `REQUIRED_SCOPES`, so a step-up must keep it to prove granted scopes are kept.
  profileOnly: { token: 'token_profile_only', scopes: ['profile'] },
  full: { token: 'token_full', scopes: [...REQUIRED_SCOPES] },
};

export type CustomerServer = { origin: string; mcpUrl: URL; close: () => Promise<void> };

export type CustomerServerKind = 'v1-route' | 'v2-registration' | 'v2-own-tool';

type Listener = (req: IncomingMessage, res: ServerResponse) => void;

// Stands in for `verifyClerkToken` after the customer's token check.
function verify(token: string | undefined): AuthInfo | undefined {
  const match = Object.values(TOKENS).find((entry) => entry.token === token);
  if (!match) return undefined;
  return {
    token: match.token,
    clientId: 'client_1',
    scopes: match.scopes,
    extra: { userId: 'user_1', verifiedBy: 'clerk' },
  };
}

function bearer(req: Request) {
  return req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
}

function toolOptions(fetchImpl: typeof fetch) {
  return {
    secretKey: 'sk_test_customer',
    destinationUrl: 'https://app.example.com/',
    requiredScopes: REQUIRED_SCOPES,
    fetch: fetchImpl,
  };
}

function resourceMetadataUrl(origin: string) {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

function metadata(origin: string, path: string): Response | undefined {
  if (path === '/.well-known/oauth-protected-resource/mcp') {
    return Response.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      // Differs from the challenge's `scope`, so a client that ignored it would ask for this list instead.
      scopes_supported: ['profile', 'offline_access', ...REQUIRED_SCOPES],
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

function unauthorized(origin: string) {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(origin)}"` },
  });
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

// Stateless responses end after one reply, so the whole body is read, then sent at once.
async function send(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

// Serves the metadata documents and the `/mcp` route of a fetch-style (Next.js-style) app.
function fetchApp(origin: string, route: (req: Request) => Promise<Response>): Listener {
  return async (req, res) => {
    const request = await toRequest(req, origin);
    const path = new URL(request.url).pathname;
    const response =
      metadata(origin, path) ??
      (path === '/mcp' ? await route(request) : new Response('Not Found', { status: 404 }));
    await send(res, response);
  };
}

const apps: Record<CustomerServerKind, (origin: string, fetchImpl: typeof fetch) => Listener> = {
  // SDK 1.x has no step-up: the route only verifies the token, and the tool refuses an under-scoped one itself.
  'v1-route': (origin, fetchImpl) =>
    fetchApp(origin, async (req) => {
      const authInfo = verify(bearer(req));
      if (!authInfo) return unauthorized(origin);
      const server = new McpServer({ name: 'customer-v1', version: '0.0.0' });
      server.registerTool(...createBrowserSessionTool(toolOptions(fetchImpl)));
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
    }),

  'v2-registration': (origin, fetchImpl) => {
    const mcpHandler = createMcpHandler(() => {
      const server = new McpServerV2({ name: 'customer-v2', version: '0.0.0' });
      server.registerTool(...createBrowserSessionTool(toolOptions(fetchImpl)));
      return server;
    });
    return fetchApp(origin, async (req) => {
      const authInfo = verify(bearer(req));
      if (!authInfo) return unauthorized(origin);
      // The tool's registration option makes the SDK send the step-up challenge.
      return mcpHandler.fetch(req, {
        authInfo: { ...authInfo, resourceMetadataUrl: resourceMetadataUrl(origin) },
      });
    });
  },

  // The customer's own tool, instrumented with `requireAdditionalScopes`.
  'v2-own-tool': (origin) => {
    const mcpHandler = createMcpHandler(() => {
      const server = new McpServerV2({ name: 'customer-own-tool', version: '0.0.0' });
      server.registerTool(
        OWN_TOOL_NAME,
        {
          description: 'Lists projects',
          scopeChallenge: requireAdditionalScopes(...OWN_TOOL_SCOPES),
        },
        async () => ({ content: [{ type: 'text' as const, text: 'projects' }] }),
      );
      return server;
    });
    return fetchApp(origin, async (req) => {
      const authInfo = verify(bearer(req));
      if (!authInfo) return unauthorized(origin);
      return mcpHandler.fetch(req, {
        authInfo: { ...authInfo, resourceMetadataUrl: resourceMetadataUrl(origin) },
      });
    });
  },
};

/** Starts a customer MCP server of `kind` with `create_browser_session`, which calls Clerk through `fetchImpl`. */
export async function startCustomerServer(
  kind: CustomerServerKind,
  fetchImpl: typeof fetch,
): Promise<CustomerServer> {
  // Listen first: the app needs the origin for its metadata documents.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', apps[kind](origin, fetchImpl));
  return {
    origin,
    mcpUrl: new URL('/mcp', origin),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
