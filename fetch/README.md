# MCP Tools - Fetch (Cloudflare Workers) Integration

Utilities for serving an authenticated MCP endpoint from a plain `fetch` Worker, such as a Cloudflare Worker that exports `{ fetch(request, env, ctx) }`, without adopting a framework. `createClerkMcpWorker` builds the whole Worker; `clerkInstrumentHandler` adds MCP to an existing one. Both can [report MCP activity to Clerk](#reporting-mcp-activity).

## Installation

```bash
npm install @clerk/mcp-tools @clerk/backend @modelcontextprotocol/server
```

These are optional peer dependencies, so the package manager doesn't install them for you or warn when one is missing. The package is ESM-only: it has no CommonJS build, so import it from an ES module.

`createClerkMcpWorker` serves MCP with `createMcpHandler` from `@modelcontextprotocol/server` (MCP SDK 2.x), which it loads on the first request. `clerkInstrumentHandler` imports no MCP SDK: it serves the handler `createMcpHandler` returns, or any `fetch`-style MCP handler. Install the SDK your handler is built with. TypeScript Workers need `@modelcontextprotocol/server` installed even then, as a dev dependency at least: the subpath's type declarations import its types for `createClerkMcpWorker`, so without it a type check with `skipLibCheck` off fails.

Both build their Clerk client with `createClerkClient` from `@clerk/backend`, from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the Worker `env` passed to `fetch`, and `CLERK_API_URL`, `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set. It never reads `process.env`. It loads the package only when it builds that client, so a Worker that passes `clerkClient` or `verifyToken` doesn't need it. Set the keys as Worker secrets:

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
```

## Quick Start

### Serving MCP from a Worker

`createClerkMcpWorker` returns the Worker export. It calls your `server` factory for each MCP request with the verified `authInfo` and the Worker `env`, so tools can reach the signed-in user and your bindings without module-level state, and serves the protected resource metadata the `401` challenge points to.

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { type ClerkEnv, createClerkMcpWorker, isClerkAuthInfo } from '@clerk/mcp-tools/fetch';

interface Env extends ClerkEnv {
  DB: D1Database;
}

export default createClerkMcpWorker<Env>({
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
  reporting: true,
  server: ({ authInfo, env }) => {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    server.registerTool(
      'count_notes',
      { description: 'Counts the notes of the Clerk user that authorized this request' },
      async () => {
        // Narrows `authInfo` to the auth info built from a Clerk token
        if (!isClerkAuthInfo(authInfo)) {
          return { isError: true, content: [{ type: 'text', text: 'Not signed in with Clerk.' }] };
        }
        const row = await env.DB.prepare('SELECT count(*) AS n FROM notes WHERE user_id = ?')
          .bind(authInfo.extra.userId)
          .first<{ n: number }>();
        return { content: [{ type: 'text', text: String(row?.n ?? 0) }] };
      },
    );
    return server;
  },
});
```

Route the MCP endpoint and its protected resource metadata URL, `/.well-known/oauth-protected-resource/mcp` here, to this Worker. It treats every other path as the MCP endpoint, so a Worker with other routes uses `clerkInstrumentHandler` instead. It serves every protocol revision MCP SDK 2.x does, including 2026-07-28 and its `server/discover`.

### Adding MCP to an existing Worker

Serve your MCP handler with `clerkInstrumentHandler`, and route the MCP endpoint and its protected resource metadata path, `/.well-known/oauth-protected-resource` followed by the endpoint's path, to the wrapped handler. Every other route of your Worker stays as it is.

```ts
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  type ClerkEnv,
  clerkInstrumentHandler,
  clerkInstrumentServer,
  isClerkAuthInfo,
} from '@clerk/mcp-tools/fetch';

interface Env extends ClerkEnv {
  DB: D1Database;
}

function createServer() {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });
  // Before registering tools, so each tool's handler time is reported
  clerkInstrumentServer(server);
  server.registerTool(
    'whoami',
    { description: 'Returns the ID of the Clerk user that authorized this request' },
    async (ctx) => {
      const authInfo = ctx.http?.authInfo;
      // Narrows `authInfo` to the auth info `clerkInstrumentHandler` built from a Clerk token
      if (!isClerkAuthInfo(authInfo)) {
        return { isError: true, content: [{ type: 'text', text: 'Not signed in with Clerk.' }] };
      }
      // `authInfo.token` is the bearer token, so return only the user ID
      return { content: [{ type: 'text', text: authInfo.extra.userId }] };
    },
  );
  return server;
}

// Created once, not per request, so its limits hold across requests
const mcpHandler = createMcpHandler(createServer);

const authedHandler = clerkInstrumentHandler<Env>(mcpHandler, {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
  reporting: true,
});

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/mcp' || pathname === '/.well-known/oauth-protected-resource/mcp') {
      return authedHandler(request, env, ctx);
    }
    // Your existing routes
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

A request without a token gets a `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` ([RFC 6750 section 3](https://datatracker.ietf.org/doc/html/rfc6750#section-3), [RFC 9728 section 5.1](https://datatracker.ietf.org/doc/html/rfc9728#section-5.1)), and the wrapped handler answers that metadata URL itself, so MCP clients can start the OAuth flow with no further routing. Browser-based MCP clients can only read the challenge if your Worker adds `Access-Control-Expose-Headers: WWW-Authenticate` to the MCP route's responses.

### Public access

A server is discoverable by default, so a client can connect and list without a token, and `publicAccess` lets it call the tools you list as well. It signs in only when it reaches something protected.

```ts
export default createClerkMcpWorker<Env>({
  resourceUrl: 'https://mcp.example.com/mcp',
  publicAccess: { tools: ['search_docs'] },
  server: ({ authInfo, env }) => {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    // Register `search_docs`, which runs without a token, and the tools that read `authInfo` and `env`
    return server;
  },
});
```

`authInfo` is `undefined` for a request that `discoverable` or `publicAccess` let through, in both the `server` factory of `createClerkMcpWorker` and the handler `clerkInstrumentHandler` serves. Set `discoverable: false` to require a token for every request. See [Public access](../README.md#public-access-sign-in-only-when-needed) in the main guide for every rule.

### With Custom Authentication

```ts
const authedHandler = clerkInstrumentHandler<Env>(mcpHandler, {
  // `env` is the Worker env, so the verifier can reach your bindings
  verifyToken: async (token, { request, env, ctx }) => verifyMyToken(token, env),
  resourceUrl: 'https://mcp.example.com/mcp',
});
```

## Reference

### `createClerkMcpWorker(options)`

Builds a Worker export, `{ fetch(request, env, ctx) }`, that serves an MCP SDK 2.x server with `createMcpHandler` from `@modelcontextprotocol/server`, behind `clerkInstrumentHandler`. It owns every path it is routed: the metadata URL of each listed `resourceUrl` gets the protected resource metadata, and every other path is the MCP endpoint, so a Worker with other routes sends only the MCP endpoint and its metadata URL to it, or uses `clerkInstrumentHandler`. The MCP handler is created once for each Worker `env`, on its first request, so its limits hold across requests: Cloudflare passes the same `env` to every request of an isolate.

- `server`: `({ authInfo, env }) => McpServer | Promise<McpServer>`, called for each MCP request that passed the auth check, with its verified auth info (`undefined` only for a request without a token that `discoverable` or `publicAccess` let through, such as a `server/discover` probe) and the Worker `env` passed to `fetch`. Return a new `McpServer` each time. The factory gets no `ctx`: the MCP handler that calls it is shared by every request with the same `env`, and the SDK hands the factory only the request's auth info, so a tool can't call `ctx.waitUntil`. A Worker whose tools need `ctx` serves its own handler with `clerkInstrumentHandler`, whose function handler receives it.
- The other options are those of [`clerkInstrumentHandler`](#clerkinstrumenthandlerhandler-options), `reporting` included, and it answers unauthenticated requests, the metadata route, and Clerk outages the same way. With `reporting`, it passes each server the factory returns to `clerkInstrumentServer` itself. Tools the factory registered before that report no handler time, so call `clerkInstrumentServer(server)` in the factory before registering them to get it; a second call does nothing.

A request throws a `Clerk error:` asking to install `@modelcontextprotocol/server` when it can't be loaded.

### `clerkInstrumentHandler(handler, options)`

Wraps a Worker's MCP handler so that every request needs a valid bearer token, and returns a function of `(request, env, ctx)`, the shape of a Worker's `fetch`. By default it verifies the OAuth access token with Clerk's `authenticateRequest`, with `acceptsToken: 'oauth_token'` and `resourceUrl` as the audience, and builds the auth info with `toClerkAuthInfo`, as the Express, Hono, and Next.js adapters do, so tool code is portable between them.

- `handler`: the handler `createMcpHandler` from `@modelcontextprotocol/server` returns, which gets the request and its `authInfo`, or a function `(request: Request, { authInfo, env, ctx }) => Response | Promise<Response>`, called for each request that passed the check, with the verified auth info (`undefined` only for a request without a token that `discoverable` or `publicAccess` let through, with `resourceMetadataUrl` added for MCP SDK 2's scope challenges), and the `env` and `ctx` the Worker was called with. Narrow `authInfo` with `isClerkAuthInfo` before reading Clerk fields such as `extra.userId`.
- `options`: the same options as the Next.js adapter's `clerkInstrumentHandler`: `resourceUrl`, `requiredScopes`, `challengeScopes`, `discoverable`, `publicAccess`, `clerkClient`, `verifyToken`, `onAuthFailure`, and `reporting`. See [the Next.js reference](../next/README.md#clerkinstrumenthandlerhandler-options) for each. These differ here:
  - `clerkClient` (optional): the Clerk client, or a function that returns one, used before the Worker env. Without it, the client is built from the Worker env as described in [Installation](#installation), and kept for later requests with the same settings. A missing key throws a `Clerk error:` naming it, such as `clerkInstrumentHandler from @clerk/mcp-tools/fetch needs the CLERK_SECRET_KEY variable in the Worker env or a clerkClient option`.
  - `verifyToken` (optional): `(token, { request, env, ctx }) => AuthInfo | undefined | Promise<AuthInfo | undefined>`, so a verifier can reach the Worker's bindings.
  - `onAuthFailure` (optional): `(failure, request) => void`, told why a request is about to get a `401` or `403` challenge or a `421`. A Worker has no request context to record it on, as the Express and Hono adapters do, so this is how it learns the reason. Pass asynchronous work to `ctx.waitUntil`; a returned promise is not awaited.
  - `reporting` (optional): see [Reporting MCP activity](#reporting-mcp-activity). Its keys come from the Worker `env`.

A missing or rejected token gets a `401` challenge, adding `error="invalid_token"` for a rejected token, a token without `requiredScopes` a `403` `insufficient_scope` challenge, and a request to an origin no listed `resourceUrl` has a `421`; `onAuthFailure` is told why. A token that could not be verified at all, such as during a Clerk outage, gets the JSON `{"error":"server_error"}` with Clerk's `429` or `5xx` status or a `500`, and the error is logged with `console.error`.

A request to the metadata URL of a listed `resourceUrl`, built as [RFC 9728 section 3.1](https://datatracker.ietf.org/doc/html/rfc9728#section-3.1) inserts `/.well-known/oauth-protected-resource` before its path and query, gets the [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728#section-3) protected resource metadata for that `resourceUrl`, with the authorization server derived from `CLERK_PUBLISHABLE_KEY` in the Worker env and `scopes_supported` listing `requiredScopes` then `challengeScopes`. An `OPTIONS` request there gets the CORS preflight, and any other method but `GET` and `HEAD` a JSON `405` with `Allow: GET, HEAD, OPTIONS` and `Cache-Control: no-store`. A Worker env without `CLERK_PUBLISHABLE_KEY` makes that request throw. Every other path or query, such as the bare `/.well-known/oauth-protected-resource`, goes through the auth check to the handler, since [RFC 9728 section 3.3](https://datatracker.ietf.org/doc/html/rfc9728#section-3.3) has clients discard metadata whose `resource` is not the URL they built its URL from. Without `resourceUrl`, any path below `/.well-known/oauth-protected-resource` gets the metadata for the resource that path describes.

## Reporting MCP activity

With `reporting`, Clerk records each tool call your MCP server answers, for your instance's MCP analytics and audit log, along with its `initialize` (or `server/discover`), list, resource read and prompt get requests, and each request answered with a `401` or `403` challenge or a `421`. Tool arguments and results are never sent. It is off by default. The reports have the fields, and `reporting` takes the options, described in [the Hono reference](../hono/README.md#reporting-mcp-activity): `ipAddress`, `userAgent`, `identity`, `tools`, `serverName`, `secretKey`, `apiUrl`, and `fetch`. In a Worker:

- `createClerkMcpWorker({ ..., reporting: true })` passes each server its factory returns to `clerkInstrumentServer`, so it reports with no other change. Call `clerkInstrumentServer(server)` in the factory before registering tools, resources, and prompts to also report each handler's time and tell a throw from a returned error.
- `clerkInstrumentHandler(handler, { ..., reporting: true })` needs `clerkInstrumentServer(server)` where each MCP server is created, as in [Adding MCP to an existing Worker](#adding-mcp-to-an-existing-worker). A POST whose server was never passed to it logs a one-time `Clerk warning:`.
- The reports are sent with `reporting.secretKey`, or else `CLERK_SECRET_KEY` from the Worker `env`, to `reporting.apiUrl`, or else `CLERK_API_URL` from the Worker `env`, then `https://api.clerk.com`. `process.env` is never read. Without a secret key, a one-time `Clerk warning:` says so and nothing is reported.
- A request's reports are sent with `ctx.waitUntil` once its response is over, so the Worker keeps running until they are sent, and sending them never delays or fails an MCP request.
- `ipAddress: true`, the default, sends `cf-connecting-ip`, which Cloudflare sets itself, for a request that has `cf`; elsewhere no address is sent unless you pass a function `({ request, env, ctx }) => string | undefined`.
- The session hash is salted with `CLERK_PUBLISHABLE_KEY` from the Worker `env`.

```ts
const authedHandler = clerkInstrumentHandler<Env>(mcpHandler, {
  resourceUrl: 'https://mcp.example.com/mcp',
  reporting: {
    userAgent: false,
    tools: (toolName) => toolName !== 'healthcheck',
    serverName: 'acme-production',
  },
});
```

Unknown keys and invalid values throw a `Clerk error:` when the handler or Worker is created.
