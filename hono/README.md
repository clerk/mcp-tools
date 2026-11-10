# MCP Tools - Hono Integration

Hono utilities for building MCP servers with authentication support.

## Installation

```bash
npm install @clerk/mcp-tools hono @modelcontextprotocol/sdk
```

`@modelcontextprotocol/sdk` is only for `streamableHttpHandler`, which runs your server on the SDK's transport. An app that uses only the auth middleware and metadata handlers, for example with MCP SDK 2's `@modelcontextprotocol/hono`, does not need it.

If you're using Clerk for authentication, also install:

```bash
npm install @clerk/hono
```

## Quick Start

### With Clerk Authentication

```ts
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { clerkMiddleware } from '@clerk/hono';
import { cors } from 'hono/cors';
import {
  mcpAuthClerk,
  protectedResourceHandler,
  authServerMetadataHandler,
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
  // `authInfo.token` is the bearer token, so return only `extra`, which holds the user ID
  server.tool('get_user', 'Gets the current user', {}, async (_, { authInfo }) => ({
    content: [{ type: 'text', text: JSON.stringify(authInfo?.extra) }],
  }));
  return server;
}

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceHandler({
    resource: MCP_RESOURCE_URL,
    scopes_supported: REQUIRED_SCOPES,
  }),
);
app.get('/.well-known/oauth-authorization-server', authServerMetadataHandler());
app.post(
  '/mcp',
  mcpAuthClerk({ resourceUrl: MCP_RESOURCE_URL, requiredScopes: REQUIRED_SCOPES }),
  streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
);

export default app;
```

### With Custom Authentication

```ts
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { mcpAuth, streamableHttpHandler } from '@clerk/mcp-tools/hono';
import { generateProtectedResourceMetadata } from '@clerk/mcp-tools/server';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const app = new Hono();
const resourceUrl = 'https://mcp.example.com/mcp';

function createServer() {
  return new McpServer({ name: 'my-server', version: '1.0.0' });
}

app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
  c.json(
    generateProtectedResourceMetadata({ authServerUrl: 'https://auth.example.com', resourceUrl }),
  ),
);

app.post(
  '/mcp',
  mcpAuth(
    async (token, c): Promise<AuthInfo | undefined> => {
      const user = await verifyMyToken(token);
      if (!user) return undefined;
      return {
        token,
        scopes: user.scopes,
        clientId: user.clientId,
        extra: { userId: user.id },
      };
    },
    { resourceUrl },
  ),
  streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
);

export default app;
```

## Reference

### `mcpAuth(verifyToken, options?)`

Middleware that enforces authentication for MCP requests. Extracts the bearer token from the `Authorization` header, calls `verifyToken`, and stores the result in Hono context for downstream handlers (`c.get('mcpAuth')`). Returns `401` with a `WWW-Authenticate` header if the token is missing, malformed, or rejected, adding `error="invalid_token"` for a rejected token.

- `options.resourceUrl`: the exact URL clients use for this endpoint, or a list of them, one for each origin, for a server that answers on several hostnames. With a list, a request uses the URL with its origin, and a request to any other origin gets a `421 Misdirected Request` without a challenge, with `c.get('mcpAuthFailure')` set to `misdirected_request`. In `mcpAuthClerk` that URL is the audience, so a token issued for one listed URL doesn't pass on another. For a list, pick the metadata route's `resource` with `matchResourceUrl` from `@clerk/mcp-tools/server`. The challenge's `resource_metadata` is derived from it. The request's origin comes from `c.req.url`, so behind a proxy that terminates TLS or rewrites `Host`, as with Node.js behind nginx, a listed URL can fail to match and every request gets a `421`: list the URLs the app itself sees, or rebuild the request URL from `X-Forwarded-*` headers you trust before this middleware. Without `resourceUrl`, the URL comes from the request, which can differ from the public URL behind a proxy. Build the metadata route with `generateProtectedResourceMetadata` from `@clerk/mcp-tools/server`, passing the same URL as its `resourceUrl`.
- `options.requiredScopes`: scopes every request needs. A token without them gets a `403` with `error="insufficient_scope"` and a `scope` that lists the granted scopes followed by the missing ones, so the new grant keeps the old access. The `401` challenge lists them in its `scope`.
- `options.challengeScopes`: more scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them.

A request the middleware answers itself, with a `401` or `403` challenge or a `421`, gets `c.get('mcpAuthFailure')`, whose `reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`, which a middleware mounted earlier can read after `await next()`, for example for logging. When `verifyToken` throws, the middleware throws an `McpAuthError` to Hono's error handler instead, with `reason: 'verification_failed'` and the thrown error as its `cause`. Under `mcpAuthClerk`, what Clerk reported is an `McpTokenVerificationError`, whose `code` is Clerk's reason, such as `token-verification-failed`, and whose `message` is Clerk's message, which says which check failed. It is the `cause` of an `invalid_token` failure for a token Clerk rejected, and the `cause` of the `McpAuthError` when Clerk answered but could not verify the token. Your own `verifyToken` can throw one to reject a token with a code. It is never sent to the client:

```ts
import { McpAuthError } from '@clerk/mcp-tools/hono';

app.onError((err, c) => {
  if (err instanceof McpAuthError) console.error('MCP auth failed', err.cause);
  return c.text('Internal Server Error', 500);
});
```

### `mcpAuthClerk({ resourceUrl, requiredScopes?, challengeScopes?, clerkClient? })`

Middleware that verifies OAuth access tokens with Clerk, including that their audience is `resourceUrl`, and otherwise behaves like `mcpAuth`. Set the metadata route's `resource` to the same URL, as in `protectedResourceHandler({ resource: resourceUrl })`: that route also derives it from the request when it is not set.

- `options.clerkClient` (optional): the Clerk client that verifies tokens. Defaults to the client `clerkMiddleware()` sets, so without this option `clerkMiddleware()` must be mounted first. `clerkMiddleware()` also verifies the token, so on the MCP route each token is verified twice. To avoid that, pass a client from `createClerkClient` in `@clerk/backend`, created with both `secretKey` and `publishableKey`, and keep `clerkMiddleware()` off the MCP route. That client must come from `@clerk/backend` 3.19.0 or later, the first with a reliable audience check.

A token Clerk rejects gets a `401` challenge. If Clerk cannot verify an opaque access token at all, for example during an outage or with an invalid secret key, the middleware throws to Hono's error handler, which answers with a `500`, so clients keep their tokens instead of restarting authorization. A JWT access token whose signing keys Clerk cannot fetch still gets the `401` challenge, because Clerk reports that failure the same way as an invalid signature.

Your Clerk instance must issue the `aud` claim. Require `@clerk/hono` 0.1.80 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

### `protectedResourceHandler(properties?)`

Handler that returns OAuth 2.0 Protected Resource Metadata (RFC 9728) for the Clerk instance in `CLERK_PUBLISHABLE_KEY`. Derives the resource URL from the current request path. For another authorization server, return `generateProtectedResourceMetadata` from `@clerk/mcp-tools/server` in your own route.

### `authServerMetadataHandler()`

Handler that fetches and returns Clerk's OAuth Authorization Server Metadata. Requires `CLERK_PUBLISHABLE_KEY`.

### `streamableHttpHandler(createServer, Transport)`

Handler that creates an `McpServer` and a transport for each request. Pass `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` as `Transport`: this package takes the class instead of importing the SDK, so apps that don't serve MCP with this handler never need the SDK, and the types are inferred from the class. Passes any auth info set by `mcpAuth`/`mcpAuthClerk` through to the MCP server. The factory must return a new server instance on every call so concurrent and abandoned requests remain isolated.
