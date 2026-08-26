# MCP Tools for Next.js

Use these helpers to serve MCP 2026-07-28, support stateless legacy clients, and complete MCP client OAuth flows with App Router handlers.

## Install

Node.js 20.9 or later is required.

```bash
npm install @clerk/mcp-tools @clerk/nextjs @modelcontextprotocol/server next zod
```

## Building an MCP server

Define a request-scoped server factory:

```ts
// lib/mcp-server.ts
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const createServer: McpServerFactory = () => {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });

  server.registerTool('get_user', { inputSchema: z.object({}) }, async (_input, context) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          userId: context.http?.authInfo?.extra?.userId,
        }),
      },
    ],
  }));

  return server;
};
```

Create the MCP route with the Clerk verifier:

```ts
// app/mcp/route.ts
import { createClerkOAuthTokenVerifier } from '@clerk/mcp-tools/server';
import { streamableHttpHandler } from '@clerk/mcp-tools/next';
import { clerkClient } from '@clerk/nextjs/server';
import { createServer } from '@/lib/mcp-server';

const clerk = await clerkClient();
const handler = streamableHttpHandler(createServer, {
  auth: {
    verifier: createClerkOAuthTokenVerifier(clerk),
    requiredScopes: ['mcp:read'],
  },
});

export { handler as GET, handler as POST, handler as DELETE };
```

## Protected Resource Metadata

Use a path-aware route. The metadata advertises `https://host/mcp`, not only the origin.

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandlerClerk,
} from '@clerk/mcp-tools/next';

const metadata = protectedResourceHandlerClerk({
  scopes_supported: ['mcp:read'],
});
const options = metadataCorsOptionsRequestHandler();

export { metadata as GET, options as OPTIONS };
```

Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` for the metadata handler and `CLERK_SECRET_KEY` for the Clerk server SDK.

Custom authorization servers can use `protectedResourceHandler({ authServerUrl, properties? })`. `authServerMetadataHandlerClerk()` remains available for legacy clients that request the authorization-server metadata document from the resource origin.

## Host and Origin validation

`streamableHttpHandler` does not validate `Host` or `Origin`. Wrap it with the SDK guards unless equivalent controls already run before the route.

```ts
import type { NextRequest } from 'next/server';
import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';

const mcp = streamableHttpHandler(createServer, { auth: { verifier } });

async function handler(request: NextRequest) {
  const rejected =
    hostHeaderValidationResponse(request, ['api.example.com']) ??
    originValidationResponse(request, ['app.example.com']);

  return rejected ?? mcp(request);
}

export { handler as GET, handler as POST, handler as DELETE };
```

Allowlist values are hostnames without schemes or ports.

## Completing client OAuth

The callback helper forwards the complete query, including RFC 9207 `iss` and OAuth error responses, to the SDK.

```ts
// app/oauth/callback/route.ts
import { completeOAuthHandler } from '@clerk/mcp-tools/next';
import { createRedisStore } from '@clerk/mcp-tools/stores/redis';
import { redirect } from 'next/navigation';

const store = createRedisStore({ host: process.env.REDIS_HOST });
const handler = completeOAuthHandler({
  store,
  callback: () => redirect('/dashboard'),
});

export { handler as GET };
```

Use the same durable store when the connection starts, when the callback runs, and when later tool calls restore the client. Provide a `redirect` callback to `getClientBySessionId` when a restored connection may need OAuth scope step-up.

## Handler options

Pass SDK bearer-auth options under `auth`. Pass `CreateMcpHandlerOptions` under `mcp`, including `legacy`, `responseMode`, `onerror`, event-bus, and keepalive settings.
