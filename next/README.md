# MCP Tools - Next.js Integration

Next.js utilities for building both MCP servers and clients with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your Next.js applications and build AI applications that can connect to MCP services.

## Installation

Make sure you have the required dependencies installed:

```bash
npm install @clerk/mcp-tools @vercel/mcp-adapter next
```

If you're using Clerk for authentication, also install the Clerk Next.js SDK:

```bash
npm install @clerk/nextjs @clerk/backend
```

## Quick Start

### Building an MCP Server

For a complete working example of an MCP server built with Next.js and Clerk authentication, see the [MCP Next.js Example](https://github.com/clerk/mcp-nextjs-example).

Here's the basic structure you'll need:

#### 1. Protected Resource Metadata

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandlerClerk } from "@clerk/mcp-tools/next";

const handler = protectedResourceHandlerClerk();

export { handler as GET };
```

#### 2. MCP Endpoint

```ts
// app/mcp/route.ts
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  createMcpHandler,
  experimental_withMcpAuth as withMcpAuth,
} from "@vercel/mcp-adapter";

const clerk = await clerkClient();

const handler = createMcpHandler((server) => {
  server.tool(
    "get-clerk-user-data",
    "Gets data about the Clerk user that authorized this request",
    {}, // tool parameters here if present
    async (_, { authInfo }) => {
      // non-null assertion is safe here, authHandler ensures presence
      const userId = authInfo!.extra!.userId! as string;
      const userData = await clerk.users.getUser(userId);

      return {
        content: [{ type: "text", text: JSON.stringify(userData) }],
      };
    }
  );
});

const authHandler = withMcpAuth(
  handler,
  async (_, token) => {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    // Note: OAuth tokens are machine tokens. Machine token usage is free
    // during our public beta period but will be subject to pricing once
    // generally available. Pricing is expected to be competitive and below
    // market averages.
    return verifyClerkToken(clerkAuth, token);
  },
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
  }
);

export { authHandler as GET, authHandler as POST };
```

**Note**: This implementation uses Vercel's `@vercel/mcp-adapter` which is specifically designed for Next.js applications and provides seamless integration with Clerk authentication.

### Building an MCP Client

For a complete working example of an MCP client implementation, see the [MCP Demo](https://github.com/clerk/mcp-demo) which shows a full client/server setup.

The MCP client functionality uses the core `@clerk/mcp-tools/client` utilities. For detailed examples of client implementation patterns, see the [main README's client guide](../README.md#guide-building-a-client) and the working demo above.

Key Next.js-specific patterns include:

### `protectedResourceHandler`

Generic Next.js route handler that returns OAuth protected resource metadata for any OAuth authorization server, as defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).

**Parameters:**

- `authServerUrl: string` - The URL of your OAuth authorization server

**Example:**

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandler } from "@clerk/mcp-tools/next";

const handler = protectedResourceHandler({
  authServerUrl: "https://auth.example.com",
});

export { handler as GET };
```

### `protectedResourceHandlerClerk`

Next.js route handler that returns OAuth protected resource metadata for Clerk integration.

**Example:**

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandlerClerk } from "@clerk/mcp-tools/next";

const handler = protectedResourceHandlerClerk();

export { handler as GET };
```

This handler automatically uses your `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` environment variable.

### `authServerMetadataHandlerClerk`

Next.js route handler for OAuth 2.0 Authorization Server Metadata endpoint based on [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414).

**Example:**

```ts
// app/.well-known/oauth-authorization-server/route.ts
import { authServerMetadataHandlerClerk } from "@clerk/mcp-tools/next";

const handler = authServerMetadataHandlerClerk();

export { handler as GET };
```

### `metadataCorsOptionsRequestHandler`

CORS options request handler for OAuth metadata endpoints. Necessary for MCP clients that operate in web browsers.

**Example:**

```ts
// app/.well-known/oauth-protected-resource/route.ts
import {
  protectedResourceHandlerClerk,
  metadataCorsOptionsRequestHandler,
} from "@clerk/mcp-tools/next";

const handler = protectedResourceHandlerClerk();
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
```

### `completeOAuthHandler`

A request handler for OAuth callback endpoints that completes the OAuth flow by exchanging authorization codes for tokens.

**Parameters:**

- `store: McpClientStore` - The client store for storing tokens
- `callback: (params) => void` - Function to call when OAuth flow completes

**Example:**

```ts
// app/oauth_callback/route.ts
import { completeOAuthHandler } from "@clerk/mcp-tools/next";
import fsStore from "@clerk/mcp-tools/stores/fs";
import { redirect } from "next/navigation";

const handler = completeOAuthHandler({
  store: fsStore,
  callback: () => redirect("/dashboard"),
});

export { handler as GET };
```

### MCP Tool Calling

For MCP tool calling in Next.js, use the framework-agnostic client utilities:

```ts
// app/api/mcp-tools/route.ts
import { getClientBySessionId } from "@clerk/mcp-tools/client";
import { cookies } from "next/headers";
import fsStore from "@clerk/mcp-tools/stores/fs";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("mcp-session")?.value;

  if (!sessionId) {
    return Response.json({ error: "No MCP session found" }, { status: 401 });
  }

  const body = await request.json();

  const { client, connect } = getClientBySessionId({
    sessionId,
    store: fsStore,
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

For custom authentication systems, you'll need to implement your own token verification and use the generic handlers:

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandler } from "@clerk/mcp-tools/next";

const handler = protectedResourceHandler({
  authServerUrl: "https://your-auth-server.com",
});

export { handler as GET };
```

## Session Management and Stores

Next.js applications, especially when deployed to serverless environments, require persistent storage for MCP sessions.

For detailed information about available stores and their configurations, see the [Stores section in the main README](../README.md#stores).

The key consideration for Next.js applications is choosing a store that works well with serverless deployments:

- **Development**: Use `fsStore` for local development
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
