# MCP Tools - Express.js Integration

Express.js utilities for building MCP servers with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your existing Express applications.

## Installation

```bash
npm install @clerk/mcp-tools @clerk/express express@5 @modelcontextprotocol/sdk
```

This package supports `express` 5, `@clerk/express` 2.1.70 or later, and `@modelcontextprotocol/sdk` 1.29.0 or later. The prebuilt tools in `@clerk/mcp-tools/tools` also need `zod` 3.25 or later, or 4: `npm install zod`.

`@modelcontextprotocol/sdk` is only for `streamableHttpHandler`, which runs your server on the SDK's transport. An app that uses only the auth middleware and metadata handlers, for example with MCP SDK 2's `toNodeHandler` from `@modelcontextprotocol/node`, does not need it. `@clerk/express` is only for verifying tokens with Clerk's default client, so an app that passes `verifyToken` or its own `clerkClient` to `mcpAuth` does not need it.

The MCP route does not need `clerkMiddleware()` from `@clerk/express`. `mcpAuth` verifies the token itself, so adding `clerkMiddleware()` in front of it only adds a second, unused authentication pass to every request.

## Quick Start

### Example with Clerk Authentication

Here's a complete example using Clerk for authentication:

```ts
import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  type McpAuthOptions,
  isClerkAuthInfo,
  mcpAuth,
  protectedResourceMetadataHandler,
  authorizationServerMetadataHandler,
  streamableHttpHandler,
} from '@clerk/mcp-tools/express';

// One object for both calls, so the metadata lists the scopes `mcpAuth` requires as `scopes_supported`
const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
} satisfies McpAuthOptions;

const app = express();
app.use(express.json());

function createServer() {
  const server = new McpServer({
    name: 'clerk-mcp-server',
    version: '1.0.0',
  });

  server.registerTool(
    'whoami',
    {
      description: 'Returns the ID of the Clerk user that authorized this request',
      inputSchema: {},
    },
    async (_args, { authInfo }) => {
      // Narrows `authInfo` to the auth info `mcpAuth` built from a Clerk token, so `extra.userId` is a string
      if (!isClerkAuthInfo(authInfo)) {
        return { isError: true, content: [{ type: 'text', text: 'Not signed in with Clerk.' }] };
      }
      // `authInfo.token` is the bearer token, so return only the user ID
      return { content: [{ type: 'text', text: authInfo.extra.userId }] };
    },
  );

  return server;
}

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceMetadataHandler(mcpAuthOptions),
);
app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
app.all(
  '/mcp',
  mcpAuth(mcpAuthOptions),
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
import {
  generateProtectedResourceMetadata,
  mcpAuth,
  streamableHttpHandler,
} from '@clerk/mcp-tools/express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const app = express();
app.use(express.json());
const resourceUrl = 'https://mcp.example.com/mcp';

// Custom token verification
// Return `undefined` to reject the token
async function verifyToken(token: string): Promise<AuthInfo | undefined> {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    return {
      token,
      clientId: decoded.azp,
      scopes: typeof decoded.scope === 'string' ? decoded.scope.split(' ') : [],
      expiresAt: decoded.exp,
      extra: { userId: decoded.sub },
    };
  } catch {
    return undefined;
  }
}

function createServer() {
  const server = new McpServer({
    name: 'custom-auth-server',
    version: '1.0.0',
  });

  // `authInfo` is what `verifyToken` returned, so the user ID is the token's `sub`
  server.registerTool(
    'whoami',
    { description: 'Returns the ID of the user that authorized this request', inputSchema: {} },
    async (_args, { authInfo }) => ({
      content: [{ type: 'text', text: String(authInfo?.extra?.userId) }],
    }),
  );

  return server;
}

// Protected resource metadata for your custom auth system
app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  res.json(
    generateProtectedResourceMetadata({
      authServerUrl: 'https://your-auth-server.com',
      resourceUrl,
    }),
  );
});

app.all(
  '/mcp',
  mcpAuth({ verifyToken, resourceUrl }),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);

app.listen(3000);
```

## Authentication Middleware

### `mcpAuth(options)`

Authentication middleware for MCP requests. By default it verifies OAuth access tokens with Clerk, including that their audience is this endpoint. Pass `verifyToken` to verify tokens with your own function instead.

**Options:**

- `resourceUrl` - The exact URL clients use for this endpoint, or a list of them, one for each origin, for a server that answers on several hostnames. Required unless you pass `verifyToken`. With a list, a request uses the URL with its origin, and a request to any other origin gets a `421 Misdirected Request` without a challenge. Under Clerk verification that URL is the audience: Clerk rejects a token whose `aud` claim does not include the URL for the request's origin, so a token issued for one listed URL doesn't pass on another. The request's origin comes from `req.protocol` and `req.host`, so behind a proxy set `trust proxy` to read them from `X-Forwarded-Proto` and `X-Forwarded-Host`. The challenge's `resource_metadata` is derived from it. With `verifyToken` and without `resourceUrl`, the URL comes from the request, which can differ from the public URL behind a proxy. Pass the same value to the metadata route, as in `protectedResourceMetadataHandler({ resourceUrl })`, so its `resource` is the URL checked here. A route of your own, built with `generateProtectedResourceMetadata` from `@clerk/mcp-tools/express`, picks the URL for a list with `matchResourceUrl`.
- `requiredScopes` (optional) - Scopes every request needs. The `401` challenge lists them in its `scope`.
- `challengeScopes` (optional) - More scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them.
- `publicAccess` (optional) - What a request without a token may do: `methods` (`true`, or a list of protocol methods), `tools` (tool names), and `resources` and `prompts` (`true`, or a list of resource URIs or prompt names). Without it, every such request gets the `401`. See [Public access](#public-access).
- `clerkClient` (optional) - The Clerk client that verifies tokens. Defaults to `clerkClient` from `@clerk/express`, which reads `CLERK_SECRET_KEY` and is loaded on the first request, so an app that passes `verifyToken` or its own client doesn't need `@clerk/express` installed. `mcpAuth` doesn't need `clerkMiddleware()` and doesn't read the auth it sets. When the secret key doesn't come from `CLERK_SECRET_KEY`, pass a client created with it here. Create it with both `secretKey` and `publishableKey`. A client from `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check. Not allowed together with `verifyToken`.
- `verifyToken` (optional) - `(token: string, req: express.Request) => AuthInfo | undefined | Promise<AuthInfo | undefined>`, a function that verifies the token in place of Clerk and returns the auth data, or `undefined` to reject it.

**Example:**

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuth, streamableHttpHandler } from '@clerk/mcp-tools/express';

app.use(express.json());
app.all(
  '/mcp',
  mcpAuth({
    resourceUrl: 'https://mcp.example.com/mcp',
    requiredScopes: ['profile', 'email'],
  }),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);
```

**Example with your own verifier:**

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuth, streamableHttpHandler } from '@clerk/mcp-tools/express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

async function verifyToken(token: string, req: express.Request): Promise<AuthInfo | undefined> {
  // Your custom token verification logic
  const user = await verifyMyToken(token);
  if (!user) return undefined; // Return undefined for invalid tokens
  // Return the auth info: `scopes` is what `requiredScopes` is checked against
  return { token, clientId: user.clientId, scopes: user.scopes, extra: { userId: user.id } };
}

app.use(express.json());
app.all(
  '/mcp',
  mcpAuth({ verifyToken }),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);
```

Earlier versions took the verifier as the first argument, `mcpAuth(verifyToken, options)`. That form now throws a `Clerk error:` at startup; pass `mcpAuth({ verifyToken, ...options })` instead.

The middleware will:

- Check for the `Authorization` header
- Extract the Bearer token
- Verify it with Clerk, or call your `verifyToken` function
- Return a 401 response with a `WWW-Authenticate` header if the token is missing, malformed, or rejected
- Return a 403 response with an `insufficient_scope` challenge if the token lacks `requiredScopes`
- Add the auth data to `req.auth` if successful

The 403 challenge's `scope` lists the token's granted scopes followed by the missing ones, so the new grant keeps the old access.

A token Clerk rejects gets a `401` challenge. If Clerk cannot verify an opaque access token at all, for example during an outage or with an invalid secret key, the middleware answers with a JSON `500`, `{"error":"server_error"}`, or the `5xx` status Clerk reported, so clients keep their tokens instead of restarting authorization. It never sends Express's HTML error page, which shows the stack trace outside production. A JWT access token whose signing keys Clerk cannot fetch still gets the `401` challenge, because Clerk reports that failure the same way as an invalid signature.

A request the middleware answers itself, with a `401` or `403` challenge or a `421`, gets `res.locals.mcpAuthFailure`, whose `reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`, for example for logging from a `res.on('finish')` listener. When `verifyToken` throws, or Clerk cannot verify the token, the middleware sends that JSON `500` and then passes an `McpAuthError` to your error middleware, with `reason: 'verification_failed'` and the thrown error as its `cause`. The response has already been sent by then, so `res.headersSent` is `true`: log the error, but don't answer again. Under Clerk verification, what Clerk reported is an `McpTokenVerificationError`, whose `code` is Clerk's reason, such as `token-verification-failed`, and whose `message` is Clerk's message, which says which check failed. It is the `cause` of an `invalid_token` failure for a token Clerk rejected, and the `cause` of the `McpAuthError` when Clerk answered but could not verify the token. Your own `verifyToken` can throw one to reject a token with a code. It is never sent to the client:

```ts
import type { ErrorRequestHandler } from 'express';
import { McpAuthError } from '@clerk/mcp-tools/express';

const logMcpAuthErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  if (!(err instanceof McpAuthError)) return next(err);
  console.error('MCP auth failed', err.reason, err.cause);
};

app.use(logMcpAuthErrors);
```

Your Clerk instance must issue the `aud` claim. Clerk turns it on when you add your first MCP server to the instance in the Clerk Dashboard; see [Build an MCP server](https://clerk.com/docs/guides/ai/mcp/build-mcp-server). Require `@clerk/express` 2.1.70 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

### Public access

`publicAccess` lets a client connect and call the tools you list without a token, and sign in only when it reaches something protected. It reads the body that `express.json()` parsed, so mount that middleware before `mcpAuth`. Without it, a JSON request without a token throws a `Clerk error:`.

```ts
app.use(express.json());
app.all(
  '/mcp',
  mcpAuth({
    resourceUrl: 'https://mcp.example.com/mcp',
    publicAccess: { methods: true, tools: ['search_docs'] },
  }),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);
```

`req.auth` is `undefined` for a request that `publicAccess` let through. See [Public access](../README.md#public-access-sign-in-only-when-needed) in the main guide for every rule.

## Protected Resource Metadata

### `protectedResourceMetadataHandler`

Express handler that returns OAuth protected resource metadata for Clerk integration, as required by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728). For another authorization server, return `generateProtectedResourceMetadata` from `@clerk/mcp-tools/express` in your own route.

**Options:** the options you pass to `mcpAuth`, all optional, plus `properties`, so one object can be passed to both. The handler ignores `clerkClient` and `verifyToken`.

- `resourceUrl` (optional) - The same value you pass to `mcpAuth`: the exact URL clients use for the endpoint, or a list of them, one for each origin. The metadata's `resource` is then the URL `mcpAuth` checks for the same request, and with a list a request to an origin none of them has gets a `421 Misdirected Request`. Without it, `resource` comes from the URL the metadata route was requested at, which can differ from the public URL behind a proxy, and MCP clients reject metadata whose `resource` differs from the URL they connect to.
- `requiredScopes` and `challengeScopes` (optional) - The same values you pass to `mcpAuth`. The metadata lists `requiredScopes` then `challengeScopes`, each once, as `scopes_supported`, and leaves `scopes_supported` out when there are none.
- `properties` (optional) - Additional metadata, such as `resource_name`. It overrides the generated metadata. A `scopes_supported` here is used as given, to list more scopes than the server asks for, but it must include every `requiredScopes` and `challengeScopes` entry, or the handler throws a `Clerk error:` naming the missing ones when it is created.

**Example:**

```ts
import { protectedResourceMetadataHandler } from '@clerk/mcp-tools/express';

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceMetadataHandler({
    resourceUrl: 'https://mcp.example.com/mcp',
    requiredScopes: ['email'],
    properties: { resource_name: 'Example MCP server' },
  }),
);
```

## Authorization Server Metadata

### `authorizationServerMetadataHandler`

Express handler that returns OAuth authorization server metadata for Clerk integration, as defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414). This endpoint provides clients with information about Clerk's OAuth authorization server capabilities and endpoints.

**Example:**

```ts
import { authorizationServerMetadataHandler } from '@clerk/mcp-tools/express';

// Serve authorization server metadata at the standard well-known location
app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
```

**Note:** This handler requires the `CLERK_PUBLISHABLE_KEY` environment variable to be set, as it uses Clerk's public configuration to generate the metadata.

## MCP Request Handler

### `streamableHttpHandler`

Express handler that processes MCP requests using the streamable HTTP transport from the MCP SDK. A fresh server and transport are created for each request, so concurrent requests don't share state. The server is stateless, so it has no session for a `GET` to stream on or a `DELETE` to end. Any request that isn't a `POST` gets a `405` with `Allow: POST` and a JSON-RPC `Method not allowed.` error, the same answer MCP SDK 2 gives. Mount it with `app.all('/mcp', ...)` behind `mcpAuth`, so a `GET` without a token reaches `mcpAuth` and gets the `401` or, with [public access](#public-access), the `405`, rather than an Express `404`.

**Parameters:**

- `createServer: () => McpServer` - A factory that returns a new MCP server instance on every call, so concurrent and abandoned requests remain isolated. Passing an `McpServer` instance instead is a type error, and throws when the handler is created.
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

  // Register your tools, resources, and prompts
  server.registerTool('ping', { description: 'Replies with pong', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));

  return server;
}

app.all('/mcp', streamableHttpHandler(createServer, StreamableHTTPServerTransport));
```

## Accessing Authentication Data in Tools

When using the authentication middleware, the auth data is automatically passed to your MCP tools through the `authInfo` parameter in the tool handler:

```ts
import { isClerkAuthInfo } from '@clerk/mcp-tools/express';

server.registerTool(
  'whoami',
  { description: 'Returns the ID of the Clerk user that authorized this request', inputSchema: {} },
  async (_args, { authInfo }) => {
    // Narrows `authInfo` to the auth info `mcpAuth` built from a Clerk token, so `extra.userId` is a string
    if (!isClerkAuthInfo(authInfo)) {
      return { isError: true, content: [{ type: 'text', text: 'Not signed in with Clerk.' }] };
    }
    return { content: [{ type: 'text', text: authInfo.extra.userId }] };
  },
);
```

For custom authentication middleware, the auth data will be whatever your `verifyToken` function returns:

```ts
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

async function verifyToken(token: string, req: express.Request): Promise<AuthInfo | undefined> {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    return {
      token,
      clientId: decoded.azp,
      scopes: typeof decoded.scope === 'string' ? decoded.scope.split(' ') : [],
      extra: { userId: decoded.sub, email: decoded.email },
    };
  } catch {
    return undefined;
  }
}

server.registerTool(
  'whoami',
  { description: 'Returns the ID of the user that authorized this request', inputSchema: {} },
  async (_args, { authInfo }) => ({
    // `authInfo` is what your verifyToken function returned
    content: [{ type: 'text', text: String(authInfo?.extra?.userId) }],
  }),
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
- **Verification unavailable**: Returns a JSON 500 (or the 5xx status Clerk reported), `{"error":"server_error"}`, then passes an `McpAuthError` to your error middleware

## Integration with Existing Express Apps

These utilities are designed to integrate seamlessly with existing Express applications. You can:

- Add MCP endpoints to existing routes
- Keep your existing authentication middleware on your other routes; the MCP route needs only `mcpAuth`
- Combine with other Express middleware (CORS, rate limiting, etc.)

```ts
import rateLimit from 'express-rate-limit';

// Apply middleware in the order you need
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(express.json());

app.all(
  '/mcp',
  mcpAuth({ resourceUrl: MCP_RESOURCE_URL }), // MCP authentication
  streamableHttpHandler(createServer, StreamableHTTPServerTransport), // MCP request handling
);
```

### CORS for browser-based MCP clients

This package doesn't set CORS headers on `/mcp` or the metadata routes; use Express middleware such as the `cors` package. For the metadata routes, `metadataCorsHeaders` from `@clerk/mcp-tools/server` holds headers that allow any origin. A browser-based client needs the response to expose `WWW-Authenticate` (`Access-Control-Expose-Headers`), or it can't read the `401` challenge ([RFC 6750 section 3](https://datatracker.ietf.org/doc/html/rfc6750#section-3)) that points it to the metadata. It also sends `Authorization`, `Content-Type`, and, after `initialize`, `Mcp-Protocol-Version`, so the preflight must allow those request headers. Mount the CORS middleware before `mcpAuth`, so it answers the `OPTIONS` preflight, which carries no token, and adds its headers to the `401` and `403`:

```ts
import cors from 'cors';

app.use(
  cors({
    allowedHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version'],
    exposedHeaders: ['WWW-Authenticate'],
  }),
);
app.use(express.json());
app.all(
  '/mcp',
  mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp' }),
  streamableHttpHandler(createServer, StreamableHTTPServerTransport),
);
```

`streamableHttpHandler` is stateless and never issues an `Mcp-Session-Id`. If you serve MCP with a stateful transport of your own, also allow `Mcp-Session-Id` as a request header and expose it.
