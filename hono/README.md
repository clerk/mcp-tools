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
import {
  mcpAuthClerk,
  protectedResourceHandlerClerk,
  authServerMetadataHandlerClerk,
  streamableHttpHandler,
} from '@clerk/mcp-tools/hono';

const app = new Hono();
app.use(clerkMiddleware());

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

server.tool('get_user', 'Gets the current user', {}, async (_, { authInfo }) => ({
  content: [{ type: 'text', text: JSON.stringify(authInfo) }],
}));

app.get('/.well-known/oauth-protected-resource', protectedResourceHandlerClerk());
app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);
app.post('/mcp', mcpAuthClerk, streamableHttpHandler(server));

export default app;
```

### With Custom Authentication

```ts
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  mcpAuth,
  protectedResourceHandler,
  streamableHttpHandler,
} from '@clerk/mcp-tools/hono';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const app = new Hono();

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

app.get(
  '/.well-known/oauth-protected-resource',
  protectedResourceHandler({ authServerUrl: 'https://auth.example.com' }),
);

app.post(
  '/mcp',
  mcpAuth(async (token, c): Promise<AuthInfo | undefined> => {
    // verify token with your auth provider
    const user = await verifyMyToken(token);
    if (!user) return undefined;
    return {
      token,
      scopes: user.scopes,
      clientId: user.clientId,
      extra: { userId: user.id },
    };
  }),
  streamableHttpHandler(server),
);

export default app;
```

## Reference

### `mcpAuth(verifyToken)`

Middleware that enforces authentication for MCP requests. Extracts the bearer token from the `Authorization` header, calls `verifyToken`, and stores the result in Hono context for downstream handlers (`c.get('mcpAuth')`). Returns `401` with a `WWW-Authenticate` header if auth fails.

### `mcpAuthClerk`

Pre-configured middleware that verifies tokens using Clerk. Requires `clerkMiddleware()` to be mounted and `CLERK_PUBLISHABLE_KEY` to be set.

### `protectedResourceHandler({ authServerUrl, properties? })`

Handler that returns OAuth 2.0 Protected Resource Metadata (RFC 9728). Derives the resource URL from the current request path.

### `protectedResourceHandlerClerk(properties?)`

Same as `protectedResourceHandler`, but derives `authServerUrl` automatically from `CLERK_PUBLISHABLE_KEY`.

### `authServerMetadataHandlerClerk`

Handler that fetches and returns Clerk's OAuth Authorization Server Metadata. Requires `CLERK_PUBLISHABLE_KEY`.

### `streamableHttpHandler(server)`

Handler that connects an `McpServer` instance to a `WebStandardStreamableHTTPServerTransport` and processes the request. Passes any auth info set by `mcpAuth`/`mcpAuthClerk` through to the MCP server.
