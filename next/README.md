# MCP Tools - Next.js Integration

Next.js utilities for building both MCP servers and clients with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your Next.js applications and build AI applications that can connect to MCP services.

## Installation

Make sure you have the required dependencies installed:

```bash
npm install @clerk/mcp-tools mcp-handler@^2.3.1 @modelcontextprotocol/server next
```

If you're using Clerk for authentication, also install the Clerk Next.js SDK:

```bash
npm install @clerk/nextjs
```

## Quick Start

### Building an MCP Server

For a complete working example of an MCP server built with Next.js and Clerk authentication, see the [MCP Next.js Example](https://github.com/clerk/mcp-nextjs-example).

Here's the basic structure you'll need:

#### 1. Protected Resource Metadata

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import { protectedResourceHandler } from '@clerk/mcp-tools/next';

// The same values as the MCP endpoint's `resourceUrl` and `requiredScopes` below
const handler = protectedResourceHandler({
  resource: 'https://mcp.example.com/mcp',
  scopes_supported: ['profile', 'email'],
});

export { handler as GET };
```

#### 2. MCP Endpoint

```ts
// app/mcp/route.ts
import { withMcpAuth } from '@clerk/mcp-tools/next';
import { clerkClient } from '@clerk/nextjs/server';
import { createMcpHandler } from 'mcp-handler';

const handler = createMcpHandler((server) => {
  server.registerTool(
    'get-clerk-user-data',
    { description: 'Gets data about the Clerk user that authorized this request' },
    async (ctx) => {
      // withMcpAuth only calls the handler with a verified token
      const userId = ctx.http!.authInfo!.extra!.userId as string;
      const clerk = await clerkClient();
      const userData = await clerk.users.getUser(userId);

      return {
        content: [{ type: 'text', text: JSON.stringify(userData) }],
      };
    },
  );
});

const authHandler = withMcpAuth(handler, {
  resourceUrl: 'https://mcp.example.com/mcp',
  clerkClient,
  requiredScopes: ['profile', 'email'],
});

export { authHandler as GET, authHandler as POST };
```

**Note**: This implementation uses Vercel's `mcp-handler` 2.x, which is specifically designed for Next.js applications and runs on `@modelcontextprotocol/server`. Import `withMcpAuth` from `@clerk/mcp-tools/next` instead of `mcp-handler`: it takes options instead of a verifier function and verifies tokens with Clerk.

### `withMcpAuth`

Wraps a Next.js MCP route handler so that every request needs an OAuth access token that Clerk verifies, including that its `aud` claim includes `resourceUrl`. It takes the same options as `mcpAuthClerk` in the Express and Hono adapters, except that `clerkClient` is required.

**Options:**

- `resourceUrl: string | string[]` - The exact URL clients use for this endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one for each origin, for a server that answers on several hostnames. With a list, a request uses the URL with its origin as the audience, so a token issued for one listed URL doesn't pass on another, and a request to any other origin gets a `421 Misdirected Request`. The request's origin comes from `req.url`. On Vercel that is the public URL, but a self-hosted app behind a proxy that terminates TLS or rewrites `Host` can see another origin, and then every request gets a `421`: list the URLs the app itself sees. Set the protected resource metadata route's `resource` to the same URL, picked with `matchResourceUrl` from `@clerk/mcp-tools/server` for a list.
- `requiredScopes?: string[]` - The scopes every request needs. The `401` challenge lists them in its `scope`.
- `challengeScopes?: string[]` - More scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them.
- `clerkClient` - The client that verifies tokens: `clerkClient` from `@clerk/nextjs/server`, or a client created with both `secretKey` and `publishableKey`. A client from `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check. It is an option rather than an import of this package so that the rest of `@clerk/mcp-tools/next` builds without `@clerk/nextjs`: Next.js fails the build on any reference to a package that isn't installed.
- `onAuthFailure?: (failure, req) => void | Promise<void>` - Called with why a request is about to be answered with a `401` or `403` challenge or a `421`, for example for logging. `failure.reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`. For a token Clerk rejected, `failure.cause` is an `McpTokenVerificationError`, whose `code` is Clerk's reason and whose `message` says which check failed. The Express and Hono adapters record the same value on the request context instead.

A missing or rejected token gets a `401` challenge, and a token without `requiredScopes` gets a `403` `insufficient_scope` challenge. The verified auth info reaches tools as `ctx.http.authInfo`, with `resourceMetadataUrl` set for step-up scope challenges. When Clerk cannot verify an opaque access token at all, for example during an outage, the handler throws an `McpAuthError`, exported from `@clerk/mcp-tools/next`, with `reason: 'verification_failed'` and the underlying error as its `cause`. Next.js answers with a `500`, so clients keep their valid token. A JWT access token whose signing keys Clerk cannot fetch still gets the `401` challenge, because Clerk reports that failure the same way as an invalid signature.

Your Clerk instance must issue the `aud` claim. Require `@clerk/nextjs` 7.9.5 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

### `mcpAuth`

The same wrapper for any authorization server: pass a function that verifies the token and returns the auth info, or `undefined` to reject it.

```ts
const authHandler = mcpAuth(async (token, req) => verifyMyToken(token), {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['read'],
})(handler);
```

### Building an MCP Client

For a complete working example of an MCP client implementation, see the [MCP Demo](https://github.com/clerk/mcp-demo) which shows a full client/server setup.

The MCP client functionality uses the core `@clerk/mcp-tools/client` utilities. For detailed examples of client implementation patterns, see the [main README's client guide](../README.md#guide-building-a-client) and the working demo above.

Key Next.js-specific patterns include:

### `protectedResourceHandler`

Next.js route handler that returns OAuth protected resource metadata for Clerk integration, as defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728). For another authorization server, see [With Custom Authentication](#with-custom-authentication).

**Example:**

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import { protectedResourceHandler } from '@clerk/mcp-tools/next';

const handler = protectedResourceHandler({ resource: 'https://mcp.example.com/mcp' });

export { handler as GET };
```

This handler automatically uses your `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` environment variable.

The metadata's `resource` comes from the route path and query, so `/.well-known/oauth-protected-resource/mcp` describes `<origin>/mcp`, `/.well-known/oauth-protected-resource/mcp/` describes `<origin>/mcp/`, and the root describes the bare origin, as RFC 9728 section 3 builds the metadata URL. MCP clients reject metadata whose `resource` differs from the URL they connect to. If clients reach the endpoint through another public URL, pass that exact URL: `protectedResourceHandler({ resource: 'https://app.example.com/mcp' })`.

### `authServerMetadataHandler`

Next.js route handler for OAuth 2.0 Authorization Server Metadata endpoint based on [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414).

**Example:**

```ts
// app/.well-known/oauth-authorization-server/route.ts
import { authServerMetadataHandler } from '@clerk/mcp-tools/next';

const handler = authServerMetadataHandler();

export { handler as GET };
```

### `metadataCorsOptionsRequestHandler`

CORS options request handler for OAuth metadata endpoints. Necessary for MCP clients that operate in web browsers.

**Example:**

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from '@clerk/mcp-tools/next';

const handler = protectedResourceHandler({ resource: 'https://mcp.example.com/mcp' });
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
```

### `completeOAuthHandler`

A request handler for OAuth callback endpoints that completes the OAuth flow by exchanging authorization codes for tokens. It is exported from `@clerk/mcp-tools/next/client`, which, like `@clerk/mcp-tools/client`, needs `@modelcontextprotocol/sdk` 1.x installed:

```bash
npm install @modelcontextprotocol/sdk
```

**Parameters:**

- `store: McpClientStore` - The client store for storing tokens
- `callback: (params) => void` - Function to call when OAuth flow completes

**Example:**

```ts
// app/oauth_callback/route.ts
import { completeOAuthHandler } from '@clerk/mcp-tools/next/client';
import { createFsStore } from '@clerk/mcp-tools/stores/fs';
import { redirect } from 'next/navigation';

const store = createFsStore();

const handler = completeOAuthHandler({
  store,
  callback: () => redirect('/dashboard'),
});

export { handler as GET };
```

### MCP Tool Calling

For MCP tool calling in Next.js, use the framework-agnostic client utilities:

```ts
// app/api/mcp-tools/route.ts
import { getMcpClientBySessionId } from '@clerk/mcp-tools/client';
import { cookies } from 'next/headers';
import { createFsStore } from '@clerk/mcp-tools/stores/fs';

const store = createFsStore();

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('mcp-session')?.value;

  if (!sessionId) {
    return Response.json({ error: 'No MCP session found' }, { status: 401 });
  }

  const body = await request.json();

  const { client, connect } = getMcpClientBySessionId({
    sessionId,
    store,
  });

  await connect();

  const toolRes = await client.callTool({
    name: body.toolName,
    arguments: body.arguments,
  });

  return Response.json(toolRes);
}
```

## Authentication Integration

### With Clerk

When using Clerk, your environment variables should include:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

The protected resource handlers will automatically use these values.

### With Custom Authentication

For custom authentication systems, verify tokens with `mcpAuth` and serve the metadata from your own route with `generateProtectedResourceMetadata`. Pass it the same `resourceUrl` you pass to `mcpAuth`:

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import { metadataCorsOptionsRequestHandler } from '@clerk/mcp-tools/next';
import { generateProtectedResourceMetadata, metadataCorsHeaders } from '@clerk/mcp-tools/server';

export function GET() {
  return Response.json(
    generateProtectedResourceMetadata({
      authServerUrl: 'https://your-auth-server.com',
      resourceUrl: 'https://mcp.example.com/mcp',
    }),
    { headers: metadataCorsHeaders },
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
```

## Session Management and Stores

Next.js applications, especially when deployed to serverless environments, require persistent storage for MCP sessions.

For detailed information about available stores and their configurations, see the [Stores section in the main README](../README.md#stores).

The key consideration for Next.js applications is choosing a store that works well with serverless deployments:

- **Development**: Use `createFsStore()` for local development
- **Production**: Use Redis, Postgres, or SQLite stores for persistent session storage

## App Router vs Pages Router

All examples in this documentation use the App Router (app directory). If you're using the Pages Router, the concepts are the same but the file locations will be different:

- `app/api/mcp/route.ts` → `pages/api/mcp.ts`
- `app/.well-known/oauth-protected-resource/route.ts` → `pages/.well-known/oauth-protected-resource.ts`

## Working Examples

For complete working examples, see these repositories:

- **[MCP Next.js Server Example](https://github.com/clerk/mcp-nextjs-example)** - A minimal example of an MCP server endpoint using Next.js and Clerk for authentication
- **[MCP Demo](https://github.com/clerk/mcp-demo)** - Example implementation of a full MCP flow using the latest spec draft, including both client and server components

These examples demonstrate real-world implementations and can serve as starting points for your own MCP integrations.
