# MCP Tools - Hono Integration

Hono utilities for building MCP servers with authentication support.

## Installation

```bash
npm install @clerk/mcp-tools hono @modelcontextprotocol/sdk
```

`@modelcontextprotocol/sdk` is only for `streamableHttpHandler`, which runs your server on the SDK's transport. An app that uses only the auth middleware and metadata handlers, for example with MCP SDK 2's `@modelcontextprotocol/hono`, does not need it.

If you're using Clerk for authentication, also install:

```bash
npm install @clerk/backend
```

`mcpAuth` builds its Clerk client with `createClerkClient` from `@clerk/backend`, from the `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` environment variables. It loads the package only when it builds that client, so an app that passes `clerkClient` or `verifyToken` doesn't need it.

## Quick Start

### With Clerk Authentication

```ts
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { cors } from 'hono/cors';
import {
  type McpAuthOptions,
  mcpAuth,
  protectedResourceMetadataHandler,
  authorizationServerMetadataHandler,
  streamableHttpHandler,
} from '@clerk/mcp-tools/hono';

// One object for both calls, so the metadata lists the scopes `mcpAuth` requires as `scopes_supported`
const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
} satisfies McpAuthOptions;

const app = new Hono();
// Browser-based MCP clients can only read the challenge if it is exposed
app.use('*', cors({ origin: '*', exposeHeaders: ['WWW-Authenticate'] }));

function createServer() {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });
  // `authInfo.token` is the bearer token, so return only the user ID that `mcpAuth` puts in `extra`
  server.tool(
    'whoami',
    'Returns the ID of the Clerk user that authorized this request',
    {},
    async (_, { authInfo }) => ({
      content: [{ type: 'text', text: String(authInfo?.extra?.userId) }],
    }),
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
  streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
);

export default app;
```

The MCP route doesn't need `clerkMiddleware()` from `@clerk/hono`. If other routes in your app do, mount it on those routes rather than on `*` or `/mcp`: it verifies the bearer token too, so on the MCP route each token would be verified twice.

### With Custom Authentication

```ts
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  generateProtectedResourceMetadata,
  mcpAuth,
  streamableHttpHandler,
} from '@clerk/mcp-tools/hono';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const app = new Hono();
const resourceUrl = 'https://mcp.example.com/mcp';

function createServer() {
  return new McpServer({ name: 'my-server', version: '1.0.0' });
}

app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
  c.json(
    generateProtectedResourceMetadata({ authServerUrl: 'https://auth.example.com', resourceUrl }),
  ),
);

app.all(
  '/mcp',
  mcpAuth({
    verifyToken: async (token, c): Promise<AuthInfo | undefined> => {
      const user = await verifyMyToken(token);
      if (!user) return undefined;
      return {
        token,
        scopes: user.scopes,
        clientId: user.clientId,
        extra: { userId: user.id },
      };
    },
    resourceUrl,
  }),
  streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
);

export default app;
```

## Reference

### `mcpAuth(options)`

Middleware that enforces authentication for MCP requests. Extracts the bearer token from the `Authorization` header, verifies it with Clerk, including that its audience is `resourceUrl`, or with your `verifyToken` function, and stores the result in Hono context for downstream handlers (`c.get('mcpAuth')`). Returns `401` with a `WWW-Authenticate` header if the token is missing, malformed, or rejected, adding `error="invalid_token"` for a rejected token.

- `resourceUrl`: the exact URL clients use for this endpoint, or a list of them, one for each origin, for a server that answers on several hostnames. Required unless you pass `verifyToken`. With a list, a request uses the URL with its origin, and a request to any other origin gets a `421 Misdirected Request` without a challenge, with `c.get('mcpAuthFailure')` set to `misdirected_request`. Under Clerk verification that URL is the audience, so a token issued for one listed URL doesn't pass on another. For a list, pick the metadata route's `resource` with `matchResourceUrl` from `@clerk/mcp-tools/hono`. The challenge's `resource_metadata` is derived from it. The request's origin comes from `c.req.url`, so behind a proxy that terminates TLS or rewrites `Host`, as with Node.js behind nginx, a listed URL can fail to match and every request gets a `421`: list the URLs the app itself sees, or rebuild the request URL from `X-Forwarded-*` headers you trust before this middleware. With `verifyToken` and without `resourceUrl`, the URL comes from the request, which can differ from the public URL behind a proxy. Pass the same value to the metadata route, as in `protectedResourceMetadataHandler({ resourceUrl })`, so its `resource` is the URL checked here, or build the route with `generateProtectedResourceMetadata` from `@clerk/mcp-tools/hono`, passing the same URL as its `resourceUrl`.
- `requiredScopes`: scopes every request needs. A token without them gets a `403` with `error="insufficient_scope"` and a `scope` that lists the granted scopes followed by the missing ones, so the new grant keeps the old access. The `401` challenge lists them in its `scope`.
- `challengeScopes`: more scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them.
- `publicAccess` (optional): what a request without a token may do: `methods` (`true`, or a list of protocol methods), `tools` (tool names), and `resources` and `prompts` (`true`, or a list of resource URIs or prompt names). Without it, every such request gets the `401`. See [Public access](#public-access).
- `clerkClient` (optional): the Clerk client that verifies tokens. Without it, `mcpAuth` builds one with `createClerkClient` from `@clerk/backend`, from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` read through Hono's `env(c)`, so it works on Cloudflare Workers, where they are only on `c.env`. It keeps that client for later requests with the same keys. A missing variable throws a `Clerk error:` that names it, and a missing `@clerk/backend` throws a `Clerk error:` asking you to install it or pass `clerkClient`. `clerkMiddleware()` also verifies the token, so keep it off the MCP route, or each token is verified twice. A client you pass must come from `@clerk/backend` 3.19.0 or later, the first with a reliable audience check. Not allowed together with `verifyToken`.
- `verifyToken` (optional): `(token: string, c: Context) => AuthInfo | undefined | Promise<AuthInfo | undefined>`, a function that verifies the token in place of Clerk and returns the auth data, or `undefined` to reject it.

Earlier versions took the verifier as the first argument, `mcpAuth(verifyToken, options)`. That form now throws a `Clerk error:` at startup; pass `mcpAuth({ verifyToken, ...options })` instead.

A token Clerk rejects gets a `401` challenge. If Clerk cannot verify an opaque access token at all, for example during an outage or with an invalid secret key, the middleware throws to Hono's error handler, and Hono's default handler answers with a JSON `500`, `{"error":"server_error"}`, and logs the error with `console.error`, so clients keep their tokens instead of restarting authorization. A JWT access token whose signing keys Clerk cannot fetch still gets the `401` challenge, because Clerk reports that failure the same way as an invalid signature.

A request the middleware answers itself, with a `401` or `403` challenge or a `421`, gets `c.get('mcpAuthFailure')`, whose `reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`, which a middleware mounted earlier can read after `await next()`, for example for logging. When `verifyToken` throws, or Clerk cannot verify the token, the middleware throws an `McpAuthError` to Hono's error handler instead, with `reason: 'verification_failed'` and the thrown error as its `cause`. A custom `onError` replaces the default answer and logging, so answer with the same JSON there. Under Clerk verification, what Clerk reported is an `McpTokenVerificationError`, whose `code` is Clerk's reason, such as `token-verification-failed`, and whose `message` is Clerk's message, which says which check failed. It is the `cause` of an `invalid_token` failure for a token Clerk rejected, and the `cause` of the `McpAuthError` when Clerk answered but could not verify the token. Your own `verifyToken` can throw one to reject a token with a code. It is never sent to the client:

```ts
import { McpAuthError } from '@clerk/mcp-tools/hono';

app.onError((err, c) => {
  if (!(err instanceof McpAuthError)) return c.text('Internal Server Error', 500);
  console.error('MCP auth failed', err.reason, err.cause);
  return c.json({ error: 'server_error' }, 500);
});
```

Your Clerk instance must issue the `aud` claim. Clerk turns it on when you add your first MCP server to the instance in the Clerk Dashboard; see [Build an MCP server](https://clerk.com/docs/guides/ai/mcp/build-mcp-server). Require `@clerk/backend` 3.19.0 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

### Public access

`publicAccess` lets a client connect and call the tools you list without a token, and sign in only when it reaches something protected.

```ts
app.all(
  '/mcp',
  mcpAuth({
    resourceUrl: 'https://mcp.example.com/mcp',
    publicAccess: { methods: true, tools: ['search_docs'] },
  }),
  streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
);
```

`c.get('mcpAuth')` is `undefined` for a request that `publicAccess` let through, and its type is `AuthInfo | undefined`. `mcpAuth` reads the body of a request without a token to check it, so a middleware before it that reads the body must use `c.req.json()` or `c.req.text()`, or read a copy, as `c.req.raw.clone().json()`. One that reads `c.req.raw` itself makes `mcpAuth` throw a `Clerk error:`. See [Public access](../README.md#public-access-sign-in-only-when-needed) in the main guide for every rule.

### `protectedResourceMetadataHandler(options?)`

Handler that returns OAuth 2.0 Protected Resource Metadata (RFC 9728) for the Clerk instance in `CLERK_PUBLISHABLE_KEY`. For another authorization server, return `generateProtectedResourceMetadata` from `@clerk/mcp-tools/hono` in your own route. It takes the options you pass to `mcpAuth`, all optional, plus `properties`, so one object can be passed to both. The handler ignores `clerkClient` and `verifyToken`.

- `resourceUrl` (optional): the same value you pass to `mcpAuth`, one URL or a list with one for each origin. The metadata's `resource` is then the URL `mcpAuth` checks for the same request, and with a list a request to an origin none of them has gets a `421 Misdirected Request`. Without it, `resource` comes from the URL the metadata route was requested at, which can differ from the public URL behind a proxy, and MCP clients reject metadata whose `resource` differs from the URL they connect to.
- `requiredScopes` and `challengeScopes` (optional): the same values you pass to `mcpAuth`. The metadata lists `requiredScopes` then `challengeScopes`, each once, as `scopes_supported`, and leaves `scopes_supported` out when there are none.
- `properties` (optional): additional metadata, such as `resource_name`. It overrides the generated metadata. A `scopes_supported` here is used as given, to list more scopes than the server asks for, but it must include every `requiredScopes` and `challengeScopes` entry, or the handler throws a `Clerk error:` naming the missing ones when it is created.

### `authorizationServerMetadataHandler()`

Handler that fetches and returns Clerk's OAuth Authorization Server Metadata. Requires `CLERK_PUBLISHABLE_KEY`.

### `streamableHttpHandler(createServer, Transport)`

Handler that creates an `McpServer` and a transport for each request. Pass `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` as `Transport`: this package takes the class instead of importing the SDK, so apps that don't serve MCP with this handler never need the SDK, and the types are inferred from the class. Passes any auth info set by `mcpAuth` through to the MCP server. The factory must return a new server instance on every call so concurrent and abandoned requests remain isolated. The server is stateless, so it has no session for a `GET` to stream on or a `DELETE` to end. Any request that isn't a `POST` gets a `405` with `Allow: POST` and a JSON-RPC `Method not allowed.` error, the same answer MCP SDK 2 gives. Mount it with `app.all('/mcp', ...)` behind `mcpAuth`, so a `GET` without a token reaches `mcpAuth` and gets the `401` or, with [public access](#public-access), the `405`, rather than a Hono `404`.
