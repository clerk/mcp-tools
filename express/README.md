# MCP Tools - Express.js Integration

Express.js utilities for building MCP servers with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your existing Express applications.

## Installation

Make sure you have the required dependencies installed:

```bash
npm install @clerk/mcp-tools express @modelcontextprotocol/sdk
```

If you're using Clerk for authentication, also install the Clerk express SDK:

```bash
npm install @clerk/express
```

## Quick Start

### Example with Clerk Authentication

Here's a complete example using Clerk for authentication:

```ts
import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createClerkClient,
  MachineAuthObject,
  clerkMiddleware,
} from "@clerk/express";
import {
  mcpAuthClerk,
  protectedResourceHandlerClerk,
  authServerMetadataHandlerClerk,
  streamableHttpHandler,
} from "@clerk/mcp-tools/express";

const app = express();
app.use(clerkMiddleware());
app.use(express.json());

const server = new McpServer({
  name: "clerk-mcp-server",
  version: "1.0.0",
});

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

server.tool(
  "get_clerk_user_data",
  "Gets data about the Clerk user that authorized this request",
  {},
  async (_, { authInfo }) => {
    const clerkAuthInfo =
      authInfo as unknown as MachineAuthObject<"oauth_token">;

    if (!clerkAuthInfo?.userId) {
      return {
        content: [{ type: "text", text: "Error: user not authenticated" }],
      };
    }

    const user = await clerk.users.getUser(clerkAuthInfo.userId);
    return {
      content: [{ type: "text", text: JSON.stringify(user) }],
    };
  }
);

app.get("/.well-known/oauth-protected-resource", protectedResourceHandlerClerk);
app.get(
  "/.well-known/oauth-authorization-server",
  authServerMetadataHandlerClerk
);
app.post("/mcp", mcpAuthClerk, streamableHttpHandler(server));

app.listen(3000);
```

### Example with Custom Authentication

Here's an example using custom JWT authentication:

```ts
import "dotenv/config";
import express from "express";
import jwt from "jsonwebtoken";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  mcpAuth,
  protectedResourceHandler,
  streamableHttpHandler,
} from "@clerk/mcp-tools/express";

const app = express();
app.use(express.json());

const server = new McpServer({
  name: "custom-auth-server",
  version: "1.0.0",
});

// Custom token verification
async function verifyToken(token: string, req: express.Request) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    return { userId: decoded.sub, email: decoded.email };
  } catch (error) {
    return false;
  }
}

server.tool(
  "get_user_data",
  "Gets data about the authenticated user",
  {},
  async (_, { authInfo }) => {
    const { userId } = authInfo as any;

    if (!userId) {
      return {
        content: [{ type: "text", text: "Error: user not authenticated" }],
      };
    }

    // Pseudo-code: Replace with your actual user data fetching logic
    // This could be a database query, API call, etc. depending on your auth provider
    const user = await fetchUserFromDatabase(userId);

    return {
      content: [{ type: "text", text: JSON.stringify(user) }],
    };
  }
);

// Protected resource metadata for your custom auth system
app.get(
  "/.well-known/oauth-protected-resource",
  protectedResourceHandler({
    authServerUrl: "https://your-auth-server.com",
  })
);

app.post("/mcp", await mcpAuth(verifyToken), streamableHttpHandler(server));

app.listen(3000);
```

## Authentication Middleware

### `mcpAuth`

Generic authentication middleware that allows you to implement custom token verification logic.

**Parameters:**

- `verifyToken: (token: string, req: express.Request) => Promise<any | false>` - Function that verifies the token and returns auth data or false

**Example:**

```ts
import { mcpAuth, streamableHttpHandler } from "@clerk/mcp-tools/express";

async function verifyToken(token: string, req: express.Request) {
  // Your custom token verification logic
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded; // Return auth data
  } catch (error) {
    return false; // Return false for invalid tokens
  }
}

app.post("/mcp", await mcpAuth(verifyToken), streamableHttpHandler(server));
```

The middleware will:

- Check for the `Authorization` header
- Extract the Bearer token
- Call your `verifyToken` function
- Return a 401 response with proper `WWW-Authenticate` header if authentication fails
- Add the auth data to `req.auth` if successful

### `mcpAuthClerk`

Pre-configured authentication middleware for Clerk that automatically handles OAuth token verification.

**Example:**

```ts
import { mcpAuthClerk, streamableHttpHandler } from "@clerk/mcp-tools/express";

// No additional configuration needed - uses Clerk's built-in token verification
app.post("/mcp", mcpAuthClerk, streamableHttpHandler(server));
```

This middleware automatically:

- Verifies OAuth access tokens using Clerk
- Handles authentication state
- Adds Clerk auth data to `req.auth`

## Protected Resource Metadata

### `protectedResourceHandler`

Generic express handler that returns OAuth protected resource metadata for any OAuth authorization server, as defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).

**Parameters:**

- `authServerUrl: string` - The URL of your OAuth authorization server
- `properties?: Record<string, any>` - Optional additional properties to include in the metadata

**Example:**

```ts
import { protectedResourceHandler } from "@clerk/mcp-tools/express";

app.get(
  "/.well-known/oauth-protected-resource",
  protectedResourceHandler({
    authServerUrl: "https://auth.example.com",
    properties: {
      service_documentation: "https://example.com/docs",
      custom_property: "custom_value",
    },
  })
);
```

### `protectedResourceHandlerClerk`

Express handler that returns OAuth protected resource metadata for Clerk integration, as required by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).

**Example:**

```ts
import { protectedResourceHandlerClerk } from "@clerk/mcp-tools/express";

app.get(
  "/.well-known/oauth-protected-resource",
  protectedResourceHandlerClerk({ scopes_supported: ["email"] })
);
```

## Authorization Server Metadata

### `authServerMetadataHandlerClerk`

Express handler that returns OAuth authorization server metadata for Clerk integration, as defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414). This endpoint provides clients with information about Clerk's OAuth authorization server capabilities and endpoints.

**Example:**

```ts
import { authServerMetadataHandlerClerk } from "@clerk/mcp-tools/express";

// Serve authorization server metadata at the standard well-known location
app.get(
  "/.well-known/oauth-authorization-server",
  authServerMetadataHandlerClerk
);
```

**Note:** This handler requires the `CLERK_PUBLISHABLE_KEY` environment variable to be set, as it uses Clerk's public configuration to generate the metadata.

## MCP Request Handler

### `streamableHttpHandler`

Express handler that processes MCP requests using the streamable HTTP transport from the MCP SDK.

**Parameters:**

- `server: McpServer` - The MCP server instance from the MCP SDK

**Example:**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { streamableHttpHandler } from "@clerk/mcp-tools/express";

const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
});

// Configure your server with tools, resources, etc.
server.setRequestHandler("tools/list", async () => {
  // Your tools implementation
});

app.post("/mcp", streamableHttpHandler(server));
```

## Accessing Authentication Data in Tools

When using the authentication middleware, the auth data is automatically passed to your MCP tools through the `authInfo` parameter in the tool handler:

```ts
server.tool(
  "authenticated_tool",
  "A tool that needs user authentication",
  { type: "object", properties: {} },
  async (args, { authInfo }) => {
    // For Clerk authentication
    const clerkAuthInfo =
      authInfo as unknown as MachineAuthObject<"oauth_token">;

    if (!clerkAuthInfo?.userId) {
      return {
        content: [{ type: "text", text: "Authentication required" }],
      };
    }

    // Use the user ID to fetch data or perform authenticated operations
    const user = await clerk.users.getUser(clerkAuthInfo.userId);

    return {
      content: [{ type: "text", text: `Hello, ${user.firstName}!` }],
    };
  }
);
```

For custom authentication middleware, the auth data will be whatever your `verifyToken` function returns:

```ts
async function verifyToken(token: string, req: express.Request) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  return { userId: decoded.sub, email: decoded.email, scopes: decoded.scope };
}

server.tool(
  "custom_auth_tool",
  "Tool using custom auth",
  { type: "object", properties: {} },
  async (args, { authInfo }) => {
    // authInfo contains whatever your verifyToken function returned
    const { userId, email, scopes } = authInfo as any;

    return {
      content: [{ type: "text", text: `User: ${email}, ID: ${userId}` }],
    };
  }
);
```

## Environment Variables

When using Clerk integration, make sure to set:

```bash
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

The publishable key is used for generating OAuth metadata, while the secret key is used for server-side API calls to fetch user data.

## Error Handling

The middleware automatically handles common authentication errors:

- **Missing Authorization header**: Returns 401 with `WWW-Authenticate` header pointing to your protected resource metadata
- **Invalid token format**: Throws an error with details about the expected format
- **Token verification failure**: Returns 401 with error details

## Integration with Existing Express Apps

These utilities are designed to integrate seamlessly with existing Express applications. You can:

- Add MCP endpoints to existing routes
- Use your existing authentication middleware alongside MCP auth
- Combine with other Express middleware (CORS, rate limiting, etc.)

```ts
import cors from "cors";
import rateLimit from "express-rate-limit";

// Apply middleware in the order you need
app.use(cors());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

app.post(
  "/mcp",
  mcpAuthClerk, // MCP authentication
  streamableHttpHandler(server) // MCP request handling
);
```
