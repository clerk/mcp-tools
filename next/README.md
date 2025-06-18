# MCP Tools - Next.js Integration

Next.js utilities for building both MCP servers and clients with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your Next.js applications and build AI applications that can connect to MCP services.

## Installation

Make sure you have the required dependencies installed:

```bash
npm install @clerk/mcp-tools @modelcontextprotocol/sdk next
```

If you're using Clerk for authentication, also install the Clerk Next.js SDK:

```bash
npm install @clerk/nextjs
```

## Quick Start

### Building an MCP Server

Here's a complete example of setting up an MCP server in Next.js with Clerk authentication:

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandlerClerk } from "@clerk/mcp-tools/next";

const handler = protectedResourceHandlerClerk();

export { handler as GET };
```

```ts
// app/api/mcp/route.ts
import { auth } from "@clerk/nextjs/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { streamableHttpHandler } from "@clerk/mcp-tools/express";
import { createClerkClient } from "@clerk/nextjs/server";

const server = new McpServer({
  name: "nextjs-mcp-server",
  version: "1.0.0",
});

const clerk = createClerkClient();

server.tool(
  "get_user_data",
  "Gets data about the authenticated user",
  { type: "object", properties: {} },
  async (_, { authInfo }) => {
    const { userId } = authInfo as any;

    if (!userId) {
      return {
        content: [{ type: "text", text: "Error: user not authenticated" }],
      };
    }

    const user = await clerk.users.getUser(userId);
    return {
      content: [{ type: "text", text: JSON.stringify(user) }],
    };
  }
);

export async function POST(request: Request) {
  const { userId } = auth();
  
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Add auth info to the request context
  const authInfo = { userId };
  
  return streamableHttpHandler(server)(request, { authInfo });
}
```

### Building an MCP Client

Here's how to build an AI application that can connect to MCP services using Next.js:

#### Step 1: MCP Registration Server Action

```ts
// app/actions/mcp-register.ts
'use server';

import { createDynamicallyRegisteredMcpClient } from "@clerk/mcp-tools/client";
import fsStore from "@clerk/mcp-tools/stores/fs";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

export async function submitIntegration(formData: FormData) {
  const mcpEndpoint = formData.get("url")?.toString();

  if (!mcpEndpoint) return { error: "MCP server url not passed" };

  const { connect, sessionId } = createDynamicallyRegisteredMcpClient({
      mcpEndpoint,
      oauthScopes: "openid profile email",
      oauthRedirectUrl: "http://localhost:3000/oauth_callback",
      oauthClientUri: "http://example.com",
      mcpClientName: "My App MCP Client",
      mcpClientVersion: "0.0.1",
      redirect: (url: string) => redirect(url),
      store: fsStore
    });

  // connect to the mcp endpoint
  await connect();

  // set mcp session id in a cookie so we can use it in tool calls later
  cookies().set('mcp-session', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
  })

  return { success: true }
}
```

#### Step 2: OAuth Callback Route

```ts
// app/oauth_callback/route.ts
import { completeOAuthHandler } from "@clerk/mcp-tools/next";
import fsStore from "@clerk/mcp-tools/stores/fs";
import { redirect } from "next/navigation";

const handler = completeOAuthHandler({
  store: fsStore,
  callback: () => redirect("/"),
});

export { handler as GET };
```

#### Step 3: MCP Tool Calling

```ts
// app/api/mcp-call/route.ts
import { mcpClientHandler } from "@clerk/mcp-tools/next";
import fsStore from "@clerk/mcp-tools/stores/fs";

const handler = mcpClientHandler(async ({ client, request }) => {
  // this assumes the "sides" argument was submitted in a POST request
  const body = await request.json();

  const toolResponse = await client.callTool({
    name: "roll_dice",
    arguments: { sides: body.sides },
  });

  return Response.json(toolResponse);
});

export { handler as POST };
```

## Server Components

### Protected Resource Metadata Handlers

#### `protectedResourceHandler`

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

#### `protectedResourceHandlerClerk`

Next.js route handler that returns OAuth protected resource metadata for Clerk integration.

**Example:**

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandlerClerk } from "@clerk/mcp-tools/next";

const handler = protectedResourceHandlerClerk();

export { handler as GET };
```

This handler automatically uses your `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` environment variable.

#### `authServerMetadataHandlerClerk`

Next.js route handler for OAuth 2.0 Authorization Server Metadata endpoint based on [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414).

**Example:**

```ts
// app/.well-known/oauth-authorization-server/route.ts
import { authServerMetadataHandlerClerk } from "@clerk/mcp-tools/next";

const handler = authServerMetadataHandlerClerk();

export { handler as GET };
```

#### `metadataCorsOptionsRequestHandler`

CORS options request handler for OAuth metadata endpoints. Necessary for MCP clients that operate in web browsers.

**Example:**

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { 
  protectedResourceHandlerClerk,
  metadataCorsOptionsRequestHandler 
} from "@clerk/mcp-tools/next";

const handler = protectedResourceHandlerClerk();
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
```

## Client Components

### OAuth Flow Handlers

#### `completeOAuthHandler`

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

#### Framework-Agnostic Alternative

If you prefer more control over the OAuth callback handling:

```ts
// app/oauth_callback/route.ts
import { completeAuthWithCode } from "@clerk/mcp-tools/client";
import fsStore from "@clerk/mcp-tools/stores/fs";
import { type NextRequest } from "next/server";
import { redirect } from "next/navigation";

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams;
  const code = qs.get("code");
  const state = qs.get("state");

  if (!state) {
    return Response.json({ error: "State missing" }, { status: 400 });
  }

  if (!code) {
    return Response.json(
      { error: "Authorization code missing" },
      { status: 400 }
    );
  }

  // this function will run the state param equality check for you
  const res = await completeAuthWithCode({ state, code, store: fsStore });

  return redirect("/dashboard");
}
```

### MCP Tool Calling

#### `mcpClientHandler`

Higher-level handler that manages MCP client connections and tool calling.

**Example:**

```ts
// app/api/mcp-tools/route.ts
import { mcpClientHandler } from "@clerk/mcp-tools/next";
import fsStore from "@clerk/mcp-tools/stores/fs";

const handler = mcpClientHandler(async ({ client, request }) => {
  const body = await request.json();

  const toolResponse = await client.callTool({
    name: body.toolName,
    arguments: body.arguments,
  });

  return Response.json(toolResponse);
});

export { handler as POST };
```

#### Framework-Agnostic Alternative

For more control over the MCP client interaction:

```ts
// app/api/mcp-tools/route.ts
import { getClientBySessionId } from "@clerk/mcp-tools/client";
import { cookies } from 'next/headers'
import fsStore from "@clerk/mcp-tools/stores/fs";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('mcp-session')?.value;

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

Next.js applications, especially when deployed to serverless environments, require persistent storage for MCP sessions. The built-in stores support this requirement:

### File System Store (Development)

```ts
import fsStore from "@clerk/mcp-tools/stores/fs";

// Good for local development
const { connect, sessionId } = createDynamicallyRegisteredMcpClient({
  // ... other options
  store: fsStore
});
```

### Production Stores

For production environments, use one of the persistent stores:

```ts
// Redis
import { createRedisStore } from '@clerk/mcp-tools/stores/redis';
const store = createRedisStore({ url: process.env.REDIS_URL });

// Postgres
import { createPostgresStore } from '@clerk/mcp-tools/stores/postgres';
const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });

// SQLite
import { createSqliteStore } from '@clerk/mcp-tools/stores/sqlite';
const store = createSqliteStore({ filename: './mcp-sessions.db' });
```

## App Router vs Pages Router

All examples in this documentation use the App Router (app directory). If you're using the Pages Router, the concepts are the same but the file locations will be different:

- `app/api/mcp/route.ts` → `pages/api/mcp.ts`
- `app/.well-known/oauth-protected-resource/route.ts` → `pages/.well-known/oauth-protected-resource.ts`

## Error Handling

The Next.js utilities include built-in error handling for common scenarios:

- **Missing environment variables**: Clear error messages about required Clerk keys
- **Invalid OAuth callbacks**: Proper error responses for missing codes or states
- **Session management**: Graceful handling of missing or invalid session cookies
- **CORS issues**: Built-in CORS headers for browser-based MCP clients

## Integration with Next.js Features

### Server Actions

MCP client registration works seamlessly with Next.js Server Actions:

```ts
// app/components/MCP-form.tsx
import { submitIntegration } from "@/app/actions/mcp-register";

export function MCPConnectionForm() {
  return (
    <form action={submitIntegration}>
      <input 
        name="url" 
        type="url" 
        placeholder="Enter MCP server URL"
        required 
      />
      <button type="submit">Connect to MCP Server</button>
    </form>
  );
}
```

### Middleware

You can combine MCP utilities with Next.js middleware for additional security or logging:

```ts
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Log MCP requests
  if (request.nextUrl.pathname.startsWith('/api/mcp')) {
    console.log('MCP request:', request.nextUrl.pathname);
  }

  return NextResponse.next();
}
```

### Environment Configuration

Use Next.js environment variable validation:

```ts
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    REQUIRED_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    REQUIRED_CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  },
};

module.exports = nextConfig;
```

## TypeScript Support

All utilities include full TypeScript support with proper type definitions for:

- Request/response objects
- Authentication context
- MCP client interfaces
- Store implementations

```ts
import type { McpClientStore } from "@clerk/mcp-tools/client";
import type { NextRequest } from "next/server";

// Custom store implementation
const customStore: McpClientStore = {
  async write(key: string, data: any) {
    // Implementation
  },
  async read(key: string) {
    // Implementation
  }
};
```

## Examples

### Complete MCP Server

A full example of an MCP server that provides authenticated access to user data:

```ts
// app/api/mcp/route.ts
import { auth } from "@clerk/nextjs/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({
  name: "user-data-server",
  version: "1.0.0",
});

server.tool(
  "get_profile",
  "Get user profile information",
  {
    type: "object",
    properties: {
      includeEmail: { type: "boolean", default: false }
    }
  },
  async (args, { authInfo }) => {
    const { userId } = authInfo as any;
    
    // Fetch user data based on authentication
    const userData = await fetchUserData(userId, args.includeEmail);
    
    return {
      content: [{ type: "text", text: JSON.stringify(userData) }],
    };
  }
);

export async function POST(request: Request) {
  const { userId } = auth();
  
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Handle MCP request with authentication context
  return handleMCPRequest(server, request, { authInfo: { userId } });
}
```

### Complete MCP Client Integration

A full example of integrating MCP client capabilities:

```ts
// app/components/ai-chat.tsx
'use client';

import { useState } from 'react';

export function AIChat() {
  const [response, setResponse] = useState('');

  const callMCPTool = async (toolName: string, args: any) => {
    const res = await fetch('/api/mcp-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName, arguments: args }),
    });

    const data = await res.json();
    setResponse(JSON.stringify(data, null, 2));
  };

  return (
    <div>
      <button onClick={() => callMCPTool('get_user_data', {})}>
        Call MCP Tool
      </button>
      <pre>{response}</pre>
    </div>
  );
}
```