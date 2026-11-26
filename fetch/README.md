# MCP Tools - Fetch (Cloudflare Workers) Integration

Utilities for adding an authenticated MCP endpoint to a plain `fetch` Worker, such as a Cloudflare Worker that exports `{ fetch(request, env, ctx) }`, without adopting a framework.

## Installation

```bash
npm install @clerk/mcp-tools @clerk/backend @modelcontextprotocol/server
```

These are optional peer dependencies, so the package manager doesn't install them for you or warn when one is missing. The package is ESM-only: it has no CommonJS build, so import it from an ES module.

`withClerkMcpAuth` imports no MCP SDK: it wraps any `fetch`-style MCP handler, such as the one `createMcpHandler` from `@modelcontextprotocol/server` (MCP SDK 2.x) returns. Install the SDK your handler is built with.

`withClerkMcpAuth` builds its Clerk client with `createClerkClient` from `@clerk/backend`, from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the Worker `env` passed to `fetch`, and `CLERK_API_URL`, `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set. It never reads `process.env`. It loads the package only when it builds that client, so a Worker that passes `clerkClient` or `verifyToken` doesn't need it. Set the keys as Worker secrets:

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
```

## Quick Start

### Adding MCP to an existing Worker

Wrap your MCP handler with `withClerkMcpAuth`, and route the MCP endpoint and the protected resource metadata path to the wrapped handler. Every other route of your Worker stays as it is.

```ts
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { type ClerkEnv, isClerkAuthInfo, withClerkMcpAuth } from '@clerk/mcp-tools/fetch';

interface Env extends ClerkEnv {
  DB: D1Database;
}

function createServer() {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });
  server.registerTool(
    'whoami',
    { description: 'Returns the ID of the Clerk user that authorized this request' },
    async (ctx) => {
      const authInfo = ctx.http?.authInfo;
      // Narrows `authInfo` to the auth info `withClerkMcpAuth` built from a Clerk token
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

const authedHandler = withClerkMcpAuth<Env>(
  (request, { authInfo }) => mcpHandler.fetch(request, { ...(authInfo && { authInfo }) }),
  {
    resourceUrl: 'https://mcp.example.com/mcp',
    requiredScopes: ['profile', 'email'],
  },
);

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/mcp' || pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return authedHandler(request, env, ctx);
    }
    // Your existing routes
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

A request without a token gets a `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` ([RFC 6750 section 3](https://datatracker.ietf.org/doc/html/rfc6750#section-3), [RFC 9728 section 5.1](https://datatracker.ietf.org/doc/html/rfc9728#section-5.1)), and the wrapped handler answers that metadata URL itself, so MCP clients can start the OAuth flow with no further routing. Browser-based MCP clients can only read the challenge if your Worker adds `Access-Control-Expose-Headers: WWW-Authenticate` to the MCP route's responses.

### With Custom Authentication

```ts
const authedHandler = withClerkMcpAuth<Env>(
  (request, { authInfo }) => mcpHandler.fetch(request, { ...(authInfo && { authInfo }) }),
  {
    // `env` is the Worker env, so the verifier can reach your bindings
    verifyToken: async (token, { request, env, ctx }) => verifyMyToken(token, env),
    resourceUrl: 'https://mcp.example.com/mcp',
  },
);
```

## Reference

### `withClerkMcpAuth(handler, options)`

Wraps a Worker's MCP handler so that every request needs a valid bearer token, and returns a function of `(request, env, ctx)`, the shape of a Worker's `fetch`. By default it verifies the OAuth access token with Clerk's `authenticateRequest`, with `acceptsToken: 'oauth_token'` and `resourceUrl` as the audience, and builds the auth info with `toClerkAuthInfo`, as the Express, Hono, and Next.js adapters do, so tool code is portable between them.

- `handler`: `(request: Request, { authInfo, env, ctx }) => Response | Promise<Response>`, called for each request that passed the check, with the verified auth info (`undefined` only for a request without a token that `publicAccess` let through, with `resourceMetadataUrl` added for MCP SDK 2's scope challenges), and the `env` and `ctx` the Worker was called with. Narrow `authInfo` with `isClerkAuthInfo` before reading Clerk fields such as `extra.userId`.
- `options`: the same options as the Next.js adapter's `withClerkMcpAuth`: `resourceUrl`, `requiredScopes`, `challengeScopes`, `discoverable`, `publicAccess`, `clerkClient`, `verifyToken`, and `onAuthFailure`. See [the Next.js reference](../next/README.md) for each. Two differ here:
  - `clerkClient` (optional): the Clerk client, or a function that returns one, used before the Worker env. Without it, the client is built from the Worker env as described in [Installation](#installation), and kept for later requests with the same settings. A missing key throws a `Clerk error:` naming it, such as `withClerkMcpAuth needs the CLERK_SECRET_KEY environment variable or a clerkClient option`.
  - `verifyToken` (optional): `(token, { request, env, ctx }) => AuthInfo | undefined | Promise<AuthInfo | undefined>`, so a verifier can reach the Worker's bindings.

A missing or rejected token gets a `401` challenge, adding `error="invalid_token"` for a rejected token, a token without `requiredScopes` a `403` `insufficient_scope` challenge, and a request to an origin no listed `resourceUrl` has a `421`; `onAuthFailure` is told why. A token that could not be verified at all, such as during a Clerk outage, gets the JSON `{"error":"server_error"}` with Clerk's `429` or `5xx` status or a `500`, and the error is logged with `console.error`.

A request to `/.well-known/oauth-protected-resource`, or a path below it, gets the [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728#section-3) protected resource metadata for `resourceUrl`, with the authorization server derived from `CLERK_PUBLISHABLE_KEY` in the Worker env and `scopes_supported` listing `requiredScopes` then `challengeScopes`. An `OPTIONS` request there gets the CORS preflight. A Worker env without `CLERK_PUBLISHABLE_KEY` makes that request throw.
