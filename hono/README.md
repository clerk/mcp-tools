# MCP Tools - Hono Integration

Hono utilities for building MCP servers with authentication support.

## Installation

```bash
npm install @clerk/mcp-tools hono @modelcontextprotocol/sdk
```

If you're using Clerk for authentication, also install:

```bash
npm install @clerk/hono
```

## Quick Start

### With Clerk Authentication

```ts
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clerkMiddleware } from '@clerk/hono';
import { cors } from 'hono/cors';
import {
  mcpAuthClerk,
  protectedResourceHandlerClerk,
  authServerMetadataHandlerClerk,
  streamableHttpHandler,
} from '@clerk/mcp-tools/hono';

const MCP_RESOURCE_URL = 'https://mcp.example.com/mcp';
const REQUIRED_SCOPES = ['profile', 'email'];

const app = new Hono();
// Browser-based MCP clients can only read the challenge if it is exposed
app.use('*', cors({ origin: '*', exposeHeaders: ['WWW-Authenticate'] }));
app.use('*', clerkMiddleware());

function createServer() {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });
  server.tool('get_user', 'Gets the current user', {}, async (_, { authInfo }) => ({
    content: [{ type: 'text', text: JSON.stringify(authInfo) }],
  }));
  return server;
}

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceHandlerClerk({
    resource: MCP_RESOURCE_URL,
    scopes_supported: REQUIRED_SCOPES,
  }),
);
app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);
app.post(
  '/mcp',
  mcpAuthClerk({ resourceUrl: MCP_RESOURCE_URL, requiredScopes: REQUIRED_SCOPES }),
  streamableHttpHandler(createServer),
);

export default app;
```

### With Custom Authentication

```ts
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpAuth, protectedResourceHandler, streamableHttpHandler } from '@clerk/mcp-tools/hono';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const app = new Hono();

function createServer() {
  return new McpServer({ name: 'my-server', version: '1.0.0' });
}

app.get(
  '/.well-known/oauth-protected-resource',
  protectedResourceHandler({ authServerUrl: 'https://auth.example.com' }),
);

app.post(
  '/mcp',
  mcpAuth(async (token, c): Promise<AuthInfo | undefined> => {
    const user = await verifyMyToken(token);
    if (!user) return undefined;
    return {
      token,
      scopes: user.scopes,
      clientId: user.clientId,
      extra: { userId: user.id },
    };
  }),
  streamableHttpHandler(createServer),
);

export default app;
```

## Reference

### `mcpAuth(verifyToken, options?)`

Middleware that enforces authentication for MCP requests. Extracts the bearer token from the `Authorization` header, calls `verifyToken`, and stores the result in Hono context for downstream handlers (`c.get('mcpAuth')`). Returns `401` with a `WWW-Authenticate` header if the token is missing, malformed, or rejected, adding `error="invalid_token"` for a rejected token.

- `options.resourceUrl`: the exact URL clients use for this endpoint. The challenge's `resource_metadata` is derived from it. Without it, the URL comes from the request, which can differ from the public URL behind a proxy.
- `options.requiredScopes`: scopes every request needs. A token without them gets a `403` with `error="insufficient_scope"` and a `scope` that lists the granted scopes followed by the missing ones, so the new grant keeps the old access.

### `mcpAuthClerk({ resourceUrl, requiredScopes? })`

Middleware that verifies OAuth access tokens with Clerk, including that their audience is `resourceUrl`, and otherwise behaves like `mcpAuth`. Requires `clerkMiddleware()` to be mounted first.

Your Clerk instance must issue the `aud` claim. Require `@clerk/hono` 0.1.80 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

### `protectedResourceHandler({ authServerUrl, properties? })`

Handler that returns OAuth 2.0 Protected Resource Metadata (RFC 9728). Derives the resource URL from the current request path.

### `protectedResourceHandlerClerk(properties?)`

Same as `protectedResourceHandler`, but derives `authServerUrl` automatically from `CLERK_PUBLISHABLE_KEY`.

### `authServerMetadataHandlerClerk`

Handler that fetches and returns Clerk's OAuth Authorization Server Metadata. Requires `CLERK_PUBLISHABLE_KEY`.

### `streamableHttpHandler(createServer)`

Handler that creates an `McpServer` and `WebStandardStreamableHTTPServerTransport` for each request. Passes any auth info set by `mcpAuth`/`mcpAuthClerk` through to the MCP server. The factory must return a new server instance on every call so concurrent and abandoned requests remain isolated.
