# MCP Tools for Hono

Use these helpers to serve MCP 2026-07-28 and stateless legacy clients from a Hono application.

## Install

Node.js 20.9 or later is required.

```bash
npm install @clerk/mcp-tools @clerk/hono @modelcontextprotocol/server hono zod
```

## Define the server once

The adapter calls the factory for each request. Do not share one `McpServer` instance across requests.

```ts
// server.ts
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const createServer: McpServerFactory = () => {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });

  server.registerTool(
    'get_user',
    {
      description: 'Gets the authenticated user ID',
      inputSchema: z.object({}),
    },
    async (_input, context) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            userId: context.http?.authInfo?.extra?.userId,
          }),
        },
      ],
    }),
  );

  return server;
};
```

## Use Clerk authentication

`mcpAuthClerk()` reads the Clerk client installed by `clerkMiddleware()`. It verifies the OAuth access token through Clerk so MCP receives its real expiration, client ID, scopes, and user ID.

```ts
import { clerkMiddleware } from '@clerk/hono';
import {
  authServerMetadataHandlerClerk,
  mcpAuthClerk,
  protectedResourceHandlerClerk,
  streamableHttpHandler,
} from '@clerk/mcp-tools/hono';
import { Hono } from 'hono';
import { createServer } from './server';

const app = new Hono();

app.use('*', clerkMiddleware());
app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceHandlerClerk({ scopes_supported: ['mcp:read'] }),
);
app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);
app.all(
  '/mcp',
  mcpAuthClerk({ requiredScopes: ['mcp:read'] }),
  streamableHttpHandler(createServer),
);

export default app;
```

The Clerk middleware needs `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`.

## Use a custom token verifier

SDK bearer authentication requires a real expiration in epoch seconds. Throw `OAuthError` with `OAuthErrorCode.InvalidToken` for an invalid or revoked token.

```ts
import { OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { mcpAuth, protectedResourceHandler, streamableHttpHandler } from '@clerk/mcp-tools/hono';

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    const result = await verifyAccessToken(token);
    if (!result) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid token');
    }

    return {
      token,
      clientId: result.clientId,
      scopes: result.scopes,
      expiresAt: result.expiresAt,
      extra: { userId: result.userId },
    };
  },
};

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceHandler({ authServerUrl: 'https://auth.example.com' }),
);
app.all(
  '/mcp',
  mcpAuth(verifier, { requiredScopes: ['mcp:read'] }),
  streamableHttpHandler(createServer),
);
```

The `mcpAuth` callback form is also supported when verification needs the Hono context.

## Host and Origin validation

`createMcpHandler` does not validate `Host` or `Origin`. Add the SDK guards when the application does not already apply equivalent controls.

```ts
import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';

app.use('/mcp', async (context, next) => {
  const rejected =
    hostHeaderValidationResponse(context.req.raw, ['api.example.com']) ??
    originValidationResponse(context.req.raw, ['app.example.com']);

  if (rejected) return rejected;
  await next();
});
```

Allowlist values are hostnames without schemes or ports.

## Handler options

The second `streamableHttpHandler` argument accepts the SDK `CreateMcpHandlerOptions`, including `legacy`, `responseMode`, `onerror`, event-bus, and keepalive settings. Legacy serving defaults to stateless fallback.
