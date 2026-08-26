# MCP Tools for Express

Use these helpers to serve MCP 2026-07-28 and stateless legacy clients from Express.

## Install

Node.js 20.9 or later is required.

```bash
npm install @clerk/mcp-tools @clerk/express @modelcontextprotocol/express @modelcontextprotocol/server express zod
```

## Define the server factory

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

The factory must return a fresh server. The adapter uses it for both protocol eras and for every request.

## Use Clerk authentication

```ts
import { clerkMiddleware } from '@clerk/express';
import {
  authServerMetadataHandlerClerk,
  mcpAuthClerk,
  protectedResourceHandlerClerk,
  streamableHttpHandler,
} from '@clerk/mcp-tools/express';
import express from 'express';
import { createServer } from './server';

const app = express();

app.use(clerkMiddleware());
app.use(express.json());
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

app.listen(3000);
```

`mcpAuthClerk()` uses the Clerk client configured by `clerkMiddleware()`. Pass `{ clerkClient }` when the application uses an explicit Clerk client instead of the default proxy.

## Use a custom verifier

```ts
import { OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { mcpAuth, protectedResourceHandler, streamableHttpHandler } from '@clerk/mcp-tools/express';

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

A request-aware callback remains supported as the first `mcpAuth` argument.

## Host and Origin validation

The MCP handler is transport-only. Apply the official Express guards unless the application already has equivalent controls.

```ts
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';

app.use(hostHeaderValidation(['api.example.com']));
app.use(originValidation(['app.example.com']));
```

Allowlist values are hostnames without schemes or ports.

## Handler options

The second `streamableHttpHandler` argument accepts `CreateMcpHandlerOptions`. Express must run `express.json()` before the MCP route because the adapter forwards the parsed request body to the SDK.
