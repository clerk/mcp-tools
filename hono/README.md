# MCP Tools - Hono Integration

Hono utilities for building MCP servers with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your existing Hono applications.

## Installation

Make sure you have the required dependencies installed:

```bash
npm install @clerk/mcp-tools hono mcp-lite
```

If you're using Clerk for authentication, also install the Clerk backend SDK:

```bash
npm install @clerk/backend
```

## Quick Start

### Example with Clerk Authentication

Here's a complete example using Clerk for authentication:

```ts
import Hono from "hono";
import { logger } from "hono/logger";
// Hono with auth does not play nicely with @modelcontextprotocol/sdk yet, so we use the mcp-lite package
import { McpServer } from "mcp-lite";
import { createClerkClient } from "@clerk/backend";
import {
  mcpAuthClerk,
  oauthCorsMiddleware,
  protectedResourceHandlerClerk,
  authServerMetadataHandlerClerk,
} from "@clerk/mcp-tools/hono";

type AppType = {
  Bindings: {
    CLERK_SECRET_KEY: string;
    CLERK_PUBLISHABLE_KEY: string;
  }
};

const app = new Hono<AppType>();

const server = new McpServer({
  name: "clerk-mcp-server",
  version: "1.0.0",
});

server.tool(
  "get_clerk_user_data",
  {
    description: "Gets data about the Clerk user that authorized this request"
    handler: async (_, { authInfo, ...mcpContext }) => {
      const clerkAuthInfo = authInfo;

      // FIXME - This code won't work yet, still need to work out how to pass in the secret key to the MCP server
      const clerk = createClerkClient({ secretKey: mcpContext.state.CLERK_SECRET_KEY! });

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
  }
);

app.use(logger());

app.on(
  ["GET", "OPTIONS"],
  "/.well-known/oauth-protected-resource",
  oauthCorsMiddleware, // <-- cors middleware is helpful for testing in the inspector
  protectedResourceHandlerClerk()
);
app.on(
  ["GET", "OPTIONS"],
  "/.well-known/oauth-protected-resource/mcp",
  oauthCorsMiddleware,
  protectedResourceHandlerClerk({
    scopes_supported: ["profile", "email"],
  })
);
app.on(
  ["GET", "OPTIONS"],
  "/.well-known/oauth-authorization-server",
  oauthCorsMiddleware,
  authServerMetadataHandlerClerk
);

app.post("/mcp", mcpAuthClerk, async (c) => {
  const authInfo = c.get("auth");
  const transport = new StreamableHttpTransport();
  const mcpHttpHandler = transport.bind(server);
  const response = await mcpHttpHandler(c.req.raw, { authInfo });
  return response;
});

export default app;
```



## Authentication Middleware

### `mcpAuthClerk`

Pre-configured authentication middleware for Clerk that automatically handles OAuth token verification.

**Example:**

```ts
import { mcpAuthClerk } from "@clerk/mcp-tools/hono";

// No additional configuration needed - uses Clerk's built-in token verification
app.post("/mcp", mcpAuthClerk, /** your mcp server handler */);
```

This middleware automatically:

- Verifies OAuth access tokens using Clerk
- Handles authentication state
- Adds Clerk auth data to request context via `c.get("auth")`

## Protected Resource Metadata

### `protectedResourceHandlerClerk`

Hono handler that returns OAuth protected resource metadata for Clerk integration, as required by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).

**Example:**

```ts
import { protectedResourceHandlerClerk } from "@clerk/mcp-tools/hono";

app.get(
  "/.well-known/oauth-protected-resource",
  protectedResourceHandlerClerk({ scopes_supported: ["email"] })
);
```

## Authorization Server Metadata

### `authServerMetadataHandlerClerk`

Hono handler that returns OAuth authorization server metadata for Clerk integration, as defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414). This endpoint provides clients with information about Clerk's OAuth authorization server capabilities and endpoints.

**Example:**

```ts
import { authServerMetadataHandlerClerk } from "@clerk/mcp-tools/hono";

// Serve authorization server metadata at the standard well-known location
app.get(
  "/.well-known/oauth-authorization-server",
  authServerMetadataHandlerClerk
);
```

**Note:** This handler requires the `CLERK_PUBLISHABLE_KEY` environment variable to be set, as it uses Clerk's public configuration to generate the metadata.


## Accessing Authentication Data in Tools

Passing authentication data to your MCP tools is done via the `authInfo` parameter in the tool handler.

The `@modelcontextprotocol/sdk` package requires that you do this by monkeypatching an `Express.Request` object, however, so it does not play nicely with Hono.

The existing Hono MCP middleware does not yet support passing auth to MCP servers, but there is an open PR to add this support: https://github.com/honojs/middleware/pull/1318/files

Alternative libraries like [`mcp-lite`](https://github.com/fiberplane/mcp) (used in the example above) do support the `authInfo` parameter, provided you pass it to the MCP server HTTP handler.

```typescript
import { McpServer } from "mcp-lite";

const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
});

server.tool(
  "my-tool",
  "My tool",
  { type: "object", properties: {} },
  async (args, { authInfo }) => {
    return { content: [{ type: "text", text: `Hello, ${authInfo.extra.userId}!` }] };
  }
);

app.post("/mcp", mcpAuthClerk, async (c) => {
  const authInfo = c.get("auth");
  const transport = new StreamableHttpTransport();
  const mcpHttpHandler = transport.bind(server);
  // pass the authInfo to the MCP server HTTP handler, making it available to the tool handlers
  const response = await mcpHttpHandler(c.req.raw, { authInfo });
  return response;
});
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

## Integration with Existing Hono Apps

These utilities are designed to integrate seamlessly with existing Hono applications. You can:

- Add MCP endpoints to existing routes
- Use your existing authentication middleware alongside MCP auth
- Combine with other Hono middleware (CORS, rate limiting, etc.)

```ts
import cors from "cors";
import { rateLimiter } from "hono-rate-limiter";

// Apply middleware in the order you need
app.use(cors());
app.use(
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 100,
  })
);

app.post(
  "/mcp",
  mcpAuthClerk, // MCP authentication
  /** your mcp server handler */
);
```
