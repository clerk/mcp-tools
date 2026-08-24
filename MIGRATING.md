# Migrating to MCP SDK v2

This release moves `@clerk/mcp-tools` to the split MCP SDK v2 packages and supports the 2026-07-28 protocol with stateless legacy fallback.

## Requirements

- Use Node.js 20.9 or later.
- Replace `@modelcontextprotocol/sdk` imports with `@modelcontextprotocol/server` or `@modelcontextprotocol/client`.
- Install Zod 4.2 or later when a server defines tool, resource, or prompt schemas.

## Server factories

HTTP adapters now take an `McpServerFactory`. Return a fresh server for each request.

```ts
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const createServer: McpServerFactory = () => {
  const server = new McpServer({ name: 'example', version: '1.0.0' });

  server.registerTool('whoami', { inputSchema: z.object({}) }, async (_input, context) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(context.http?.authInfo?.extra),
      },
    ],
  }));

  return server;
};
```

Replace these v1 patterns:

- `server.tool(...)` becomes `server.registerTool(...)`.
- A shared server instance becomes a request-scoped factory.
- Handler auth moves from a flat callback field to `context.http?.authInfo`.
- Mount HTTP handlers for every method with `app.all('/mcp', ...)` or export them as `GET`, `POST`, and `DELETE`.
- Call the Clerk middleware factory as `mcpAuthClerk()`; pass `requiredScopes` in its options when needed.

## Bearer authentication

SDK v2 rejects auth data without a real token expiration. Use `createClerkOAuthTokenVerifier` for Clerk OAuth access tokens. It supports opaque tokens and sets `AuthInfo.expiresAt` from Clerk's verified token record.

```ts
import { createClerkOAuthTokenVerifier } from '@clerk/mcp-tools/server';

const verifier = createClerkOAuthTokenVerifier(clerkClient);
```

Custom verifiers must return `token`, `clientId`, `scopes`, and `expiresAt`. Throw `OAuthError(OAuthErrorCode.InvalidToken, ...)` for an invalid or revoked token. Framework adapters delegate bearer parsing, expiry checks, scope checks, and OAuth challenges to the SDK's `requireBearerAuth` implementation.

`createMcpHandler` does not validate `Host` or `Origin`. Use the official SDK host and origin guards before the MCP route unless the application already applies equivalent controls. The framework guides include copy-ready examples.

## Client OAuth state

Client helpers now use automatic protocol negotiation. They first probe the 2026-07-28 protocol and fall back to the legacy handshake when required.

Persist the same store across connection start, OAuth callback, and later tool calls. The helpers now store complete OAuth client information, complete token responses, issuer stamps, refresh tokens, scopes, and discovery state.

Pass the full callback query to preserve RFC 9207 issuer validation:

```ts
await completeAuthWithCode({
  callbackParams: request.nextUrl.searchParams,
  store,
});
```

When restoring a client, provide `redirect` if a later `403 insufficient_scope` response can start a scope step-up flow:

```ts
const connection = await getClientBySessionId({
  sessionId,
  store,
  redirect: (url) => redirect(url),
});
```

The older `{ code, state, iss?, store }` callback form remains supported.
