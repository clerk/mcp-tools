# MCP Tools - Express.js Integration

Express.js utilities for building MCP servers with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your existing Express applications.

## Installation

Make sure you have the required dependencies installed:

```bash
npm install @clerk/mcp-tools express @modelcontextprotocol/sdk
```

`@modelcontextprotocol/sdk` is only for `streamableHttpHandler`, which runs your server on the SDK's transport. An app that uses only the auth middleware and metadata handlers, for example with MCP SDK 2's `toNodeHandler` from `@modelcontextprotocol/node`, does not need it.

If you're using Clerk for authentication, also install the Clerk express SDK:

```bash
npm install @clerk/express
```

## Quick Start

### Example with Clerk Authentication

Here's a complete example using Clerk for authentication:

```ts
import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createClerkClient } from '@clerk/express';
import {
  mcpAuthClerk,
  protectedResourceHandlerClerk,
  authServerMetadataHandlerClerk,
  streamableHttpHandler,
} from '@clerk/mcp-tools/express';

const MCP_RESOURCE_URL = 'https://mcp.example.com/mcp';
const REQUIRED_SCOPES = ['profile', 'email'];

const app = express();
app.use(express.json());

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

function createServer() {
  const server = new McpServer({
    name: 'clerk-mcp-server',
    version: '1.0.0',
  });

  server.tool(
    'get_clerk_user_data',
    'Gets data about the Clerk user that authorized this request',
    {},
    async (_, { authInfo }) => {
      const userId = authInfo?.extra?.userId as string | undefined;

      if (!userId) {
        return {
          content: [{ type: 'text', text: 'Error: user not authenticated' }],
        };
      }

      const user = await clerk.users.getUser(userId);
      return {
        content: [{ type: 'text', text: JSON.stringify(user) }],
      };
    },
  );

  return server;
}

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceHandlerClerk({
    resource: MCP_RESOURCE_URL,
    scopes_supported: REQUIRED_SCOPES,
  }),
);
app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);
app.post(
  '/mcp',
  mcpAuthClerk({ resourceUrl: MCP_RESOURCE_URL, requiredScopes: REQUIRED_SCOPES }),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);

app.listen(3000);
```

### Example with Custom Authentication

Here's an example using custom JWT authentication:

```ts
import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuth, protectedResourceHandler, streamableHttpHandler } from '@clerk/mcp-tools/express';

const app = express();
app.use(express.json());

// Custom token verification
async function verifyToken(token: string, req: express.Request) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    return { userId: decoded.sub, email: decoded.email };
  } catch (error) {
    return false;
  }
}

function createServer() {
  const server = new McpServer({
    name: 'custom-auth-server',
    version: '1.0.0',
  });

  server.tool(
    'get_user_data',
    'Gets data about the authenticated user',
    {},
    async (_, { authInfo }) => {
      const { userId } = authInfo as any;

      if (!userId) {
        return {
          content: [{ type: 'text', text: 'Error: user not authenticated' }],
        };
      }

      // Pseudo-code: Replace with your actual user data fetching logic
      // This could be a database query, API call, etc. depending on your auth provider
      const user = await fetchUserFromDatabase(userId);

      return {
        content: [{ type: 'text', text: JSON.stringify(user) }],
      };
    },
  );

  return server;
}

// Protected resource metadata for your custom auth system
app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceHandler({
    authServerUrl: 'https://your-auth-server.com',
  }),
);

app.post(
  '/mcp',
  mcpAuth(verifyToken),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);

app.listen(3000);
```

## Authentication Middleware

### `mcpAuth`

Generic authentication middleware that allows you to implement custom token verification logic.

**Parameters:**

- `verifyToken: (token: string, req: express.Request) => Promise<AuthInfo | undefined>` - Function that verifies the token and returns the auth data, or `undefined` to reject it
- `options.resourceUrl` (optional) - The exact URL clients use for this endpoint, or a list of them, one for each origin, for a server that answers on several hostnames. With a list, a request uses the URL with its origin, and a request to any other origin gets a `421 Misdirected Request` without a challenge. The request's origin comes from `req.protocol` and the `Host` header, so behind a proxy set `trust proxy`. The challenge's `resource_metadata` is derived from it. Without it, the URL comes from the request, which can differ from the public URL behind a proxy. Set the metadata route's `resource` to the same URL, as in `protectedResourceHandler({ authServerUrl, properties: { resource: resourceUrl } })`: that route also derives it from the request when it is not set.
- `options.requiredScopes` (optional) - Scopes every request needs. The `401` challenge lists them in its `scope`.
- `options.challengeScopes` (optional) - More scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them.

**Example:**

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuth, streamableHttpHandler } from '@clerk/mcp-tools/express';

async function verifyToken(token: string, req: express.Request) {
  // Your custom token verification logic
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded; // Return auth data
  } catch (error) {
    return false; // Return false for invalid tokens
  }
}

app.post(
  '/mcp',
  mcpAuth(verifyToken),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);
```

The middleware will:

- Check for the `Authorization` header
- Extract the Bearer token
- Call your `verifyToken` function
- Return a 401 response with a `WWW-Authenticate` header if the token is missing, malformed, or rejected
- Return a 403 response with an `insufficient_scope` challenge if the token lacks `requiredScopes`
- Add the auth data to `req.auth` if successful

A request the middleware answers itself, with a `401` or `403` challenge or a `421`, gets `res.locals.mcpAuthFailure`, whose `reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`, for example for logging from a `res.on('finish')` listener. When `verifyToken` throws, the middleware passes an `McpAuthError` to Express instead, with `reason: 'verification_failed'` and the thrown error as its `cause`. Under `mcpAuthClerk`, what Clerk reported is an `McpTokenVerificationError`, whose `code` is Clerk's reason, such as `token-verification-failed`, and whose `message` is Clerk's message, which says which check failed. It is the `cause` of an `invalid_token` failure for a token Clerk rejected, and the `cause` of the `McpAuthError` when Clerk answered but could not verify the token. Your own `verifyToken` can throw one to reject a token with a code. It is never sent to the client:

```ts
import { McpAuthError } from '@clerk/mcp-tools/express';

app.use((err, req, res, next) => {
  if (err instanceof McpAuthError) console.error('MCP auth failed', err.cause);
  next(err);
});
```

### `mcpAuthClerk`

Authentication middleware that verifies OAuth access tokens with Clerk, including that their audience is this endpoint.

**Parameters:**

- `options.resourceUrl` - The exact URL clients use for this endpoint, or a list of them, one for each origin, as for `mcpAuth`. Clerk rejects a token whose `aud` claim does not include the URL for the request's origin, so a token issued for one listed URL doesn't pass on another. For a list, pick the metadata route's `resource` with `matchResourceUrl` from `@clerk/mcp-tools/server`. Set the metadata route's `resource` to the same URL, as in `protectedResourceHandlerClerk({ resource: resourceUrl })`: that route also derives it from the request when it is not set.
- `options.requiredScopes` (optional) - Scopes every request needs
- `options.challengeScopes` (optional) - As for `mcpAuth`
- `options.clerkClient` (optional) - The Clerk client that verifies tokens. Defaults to `clerkClient` from `@clerk/express`, which reads `CLERK_SECRET_KEY`. If you pass the secret key or a client to `clerkMiddleware()` instead, pass the same client here. Create it with both `secretKey` and `publishableKey`. A client from `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check.

A token Clerk rejects gets a `401` challenge. If Clerk cannot verify an opaque access token at all, for example during an outage or with an invalid secret key, the middleware passes an error to Express, which answers with a `500`, so clients keep their tokens instead of restarting authorization. A JWT access token whose signing keys Clerk cannot fetch still gets the `401` challenge, because Clerk reports that failure the same way as an invalid signature.

**Example:**

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthClerk, streamableHttpHandler } from '@clerk/mcp-tools/express';

app.post(
  '/mcp',
  mcpAuthClerk({
    resourceUrl: 'https://mcp.example.com/mcp',
    requiredScopes: ['profile', 'email'],
  }),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);
```

The 403 challenge's `scope` lists the token's granted scopes followed by the missing ones, so the new grant keeps the old access.

Your Clerk instance must issue the `aud` claim. Require `@clerk/express` 2.1.70 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

## Protected Resource Metadata

### `protectedResourceHandler`

Generic express handler that returns OAuth protected resource metadata for any OAuth authorization server, as defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).

**Parameters:**

- `authServerUrl: string` - The URL of your OAuth authorization server
- `properties?: Record<string, any>` - Optional additional properties to include in the metadata

**Example:**

```ts
import { protectedResourceHandler } from '@clerk/mcp-tools/express';

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceHandler({
    authServerUrl: 'https://auth.example.com',
    properties: {
      service_documentation: 'https://example.com/docs',
      custom_property: 'custom_value',
    },
  }),
);
```

### `protectedResourceHandlerClerk`

Express handler that returns OAuth protected resource metadata for Clerk integration, as required by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).

**Example:**

```ts
import { protectedResourceHandlerClerk } from '@clerk/mcp-tools/express';

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceHandlerClerk({ scopes_supported: ['email'] }),
);
```

## Authorization Server Metadata

### `authServerMetadataHandlerClerk`

Express handler that returns OAuth authorization server metadata for Clerk integration, as defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414). This endpoint provides clients with information about Clerk's OAuth authorization server capabilities and endpoints.

**Example:**

```ts
import { authServerMetadataHandlerClerk } from '@clerk/mcp-tools/express';

// Serve authorization server metadata at the standard well-known location
app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);
```

**Note:** This handler requires the `CLERK_PUBLISHABLE_KEY` environment variable to be set, as it uses Clerk's public configuration to generate the metadata.

## MCP Request Handler

### `streamableHttpHandler`

Express handler that processes MCP requests using the streamable HTTP transport from the MCP SDK. A fresh server and transport are created for each request, so concurrent requests don't share state.

**Parameters:**

- `createServer: () => McpServer` - A factory that returns a new MCP server instance. Passing a plain `McpServer` instance is also supported for backwards compatibility, but a shared server can only handle one request at a time, so a factory is strongly recommended.
- `Transport` - `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`. This package takes the class instead of importing the SDK, so apps that don't serve MCP with this handler never need the SDK, and the types are inferred from the class.

**Example:**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { streamableHttpHandler } from '@clerk/mcp-tools/express';

function createServer() {
  const server = new McpServer({
    name: 'my-server',
    version: '1.0.0',
  });

  // Configure your server with tools, resources, etc.
  server.setRequestHandler('tools/list', async () => {
    // Your tools implementation
  });

  return server;
}

app.post('/mcp', streamableHttpHandler(createServer, StreamableHTTPServerTransport));
```

## Accessing Authentication Data in Tools

When using the authentication middleware, the auth data is automatically passed to your MCP tools through the `authInfo` parameter in the tool handler:

```ts
server.tool(
  'authenticated_tool',
  'A tool that needs user authentication',
  { type: 'object', properties: {} },
  async (args, { authInfo }) => {
    // For Clerk authentication, mcpAuthClerk puts the user ID in `extra`
    const userId = authInfo?.extra?.userId as string | undefined;

    if (!userId) {
      return {
        content: [{ type: 'text', text: 'Authentication required' }],
      };
    }

    // Use the user ID to fetch data or perform authenticated operations
    const user = await clerk.users.getUser(userId);

    return {
      content: [{ type: 'text', text: `Hello, ${user.firstName}!` }],
    };
  },
);
```

For custom authentication middleware, the auth data will be whatever your `verifyToken` function returns:

```ts
async function verifyToken(token: string, req: express.Request) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  return { userId: decoded.sub, email: decoded.email, scopes: decoded.scope };
}

server.tool(
  'custom_auth_tool',
  'Tool using custom auth',
  { type: 'object', properties: {} },
  async (args, { authInfo }) => {
    // authInfo contains whatever your verifyToken function returned
    const { userId, email, scopes } = authInfo as any;

    return {
      content: [{ type: 'text', text: `User: ${email}, ID: ${userId}` }],
    };
  },
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

- **Missing Authorization header**: Returns 401 with a `WWW-Authenticate` header pointing to your protected resource metadata
- **Invalid token format**: Returns 401 with the same challenge
- **Token verification failure**: Returns 401 with the same challenge plus `error="invalid_token"`
- **Missing required scopes**: Returns 403 with the same challenge plus `error="insufficient_scope"` and `scope`

## Integration with Existing Express Apps

These utilities are designed to integrate seamlessly with existing Express applications. You can:

- Add MCP endpoints to existing routes
- Use your existing authentication middleware alongside MCP auth
- Combine with other Express middleware (CORS, rate limiting, etc.)

```ts
import cors from 'cors';
import rateLimit from 'express-rate-limit';

// Apply middleware in the order you need
// Browser-based MCP clients can only read the challenge if it is exposed
app.use(cors({ exposedHeaders: ['WWW-Authenticate'] }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

app.post(
  '/mcp',
  mcpAuthClerk({ resourceUrl: MCP_RESOURCE_URL }), // MCP authentication
  streamableHttpHandler(createServer, StreamableHTTPServerTransport), // MCP request handling
);
```
