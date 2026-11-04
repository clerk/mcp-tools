// Test-only: MCP servers set up the way a customer would, on MCP SDK 1.x and 2.x, served over real HTTP.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { clerkMiddleware } from '@clerk/hono';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer as McpServerV2 } from '@modelcontextprotocol/server';

import { createBrowserSessionTool } from '../create-browser-session';
import { createMcpAuthClerk as createMcpAuthClerkExpress } from '../express';
import { createMcpAuthClerk as createMcpAuthClerkHono } from '../hono';
import { scopeChallengeFor } from '../server';
import { signAccessToken, useFakeClerk } from './fake-clerk';

export const REQUIRED_SCOPES = ['email', 'user:org:read'] as const;

export const OWN_TOOL_NAME = 'list_projects';
export const OWN_TOOL_SCOPES = ['projects:read'];

/** Bearer tokens the servers accept, and the scopes each one grants. */
export const TOKENS = {
  // A scope outside `REQUIRED_SCOPES`, so a step-up must keep it to prove granted scopes are kept.
  profileOnly: { token: 'token_profile_only', scopes: ['profile'] },
  full: { token: 'token_full', scopes: [...REQUIRED_SCOPES] },
};

export type CustomerServer = {
  origin: string;
  mcpUrl: URL;
  /** The bearer token for `name`. The Express and Hono servers verify real signed tokens, so theirs name this server. */
  token: (name: TokenName) => string;
  close: () => Promise<void>;
};

export type TokenName = keyof typeof TOKENS | 'wrongAudience';

export type CustomerServerKind =
  | 'v1-route'
  | 'v2-registration'
  | 'v2-own-tool'
  | 'express-v2'
  | 'hono-v2';

/** The kinds that verify tokens through `createMcpAuthClerk`, so Clerk's own verification runs. */
const CLERK_VERIFIED_KINDS: readonly CustomerServerKind[] = ['express-v2', 'hono-v2'];

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
      // More than the tool needs: a client that ignored the challenge's `scope` would ask for this list instead.
      scopes_supported: ['profile', ...REQUIRED_SCOPES],
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

// A customer's MCP server instance for the SDK 2.x adapters, with `create_browser_session` registered.
function createV2Handler(fetchImpl: typeof fetch) {
  return createMcpHandler(() => {
    const server = new McpServerV2({ name: 'customer-adapter', version: '0.0.0' });
    server.registerTool(...createBrowserSessionTool(toolOptions(fetchImpl)));
    return server;
  });
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

  // The README's Express setup: `createMcpAuthClerk` in front of the SDK 2.x Node adapter, which reads `req.auth`.
  'express-v2': (origin, fetchImpl) => {
    const mcpHandler = toNodeHandler(createV2Handler(fetchImpl));
    const app = createMcpExpressApp();
    app.get(/^\/\.well-known\//, async (req, res) => {
      const document = metadata(origin, req.path);
      if (document) await send(res, document);
      else res.status(404).end();
    });
    app.post('/mcp', createMcpAuthClerkExpress({ audience: `${origin}/mcp` }), (req, res) =>
      mcpHandler(req, res, req.body),
    );
    return app;
  },

  // The README's Hono setup: `clerkMiddleware` and `createMcpAuthClerk` in front of the SDK 2.x web-standard handler.
  'hono-v2': (origin, fetchImpl) => {
    const mcpHandler = createV2Handler(fetchImpl);
    const app = createMcpHonoApp();
    app.use('/mcp', clerkMiddleware());
    app.all('/mcp', createMcpAuthClerkHono({ audience: `${origin}/mcp` }), (c) =>
      mcpHandler.fetch(c.req.raw, { authInfo: c.get('mcpAuth') }),
    );
    return fetchApp(origin, (req) => Promise.resolve(app.fetch(req)));
  },

  // The customer's own tool, instrumented with `scopeChallengeFor`.
  'v2-own-tool': (origin) => {
    const mcpHandler = createMcpHandler(() => {
      const server = new McpServerV2({ name: 'customer-own-tool', version: '0.0.0' });
      server.registerTool(
        OWN_TOOL_NAME,
        {
          description: 'Lists projects',
          scopeChallenge: scopeChallengeFor(OWN_TOOL_SCOPES),
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
  if (CLERK_VERIFIED_KINDS.includes(kind)) await useFakeClerk();
  // Listen first: the app needs the origin for its metadata documents.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', apps[kind](origin, fetchImpl));
  return {
    origin,
    mcpUrl: new URL('/mcp', origin),
    token: (name) => {
      if (!CLERK_VERIFIED_KINDS.includes(kind)) {
        if (name === 'wrongAudience') throw new Error(`${kind} does not check the audience`);
        return TOKENS[name].token;
      }
      const resource = `${origin}/mcp`;
      return name === 'wrongAudience'
        ? signAccessToken({ aud: 'https://other.example.com/mcp', scopes: REQUIRED_SCOPES })
        : signAccessToken({ aud: resource, scopes: TOKENS[name].scopes });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
