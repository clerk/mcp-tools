# MCP Tools - Next.js Integration

Next.js utilities for building both MCP servers and clients with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your Next.js applications and build AI applications that can connect to MCP services.

## Installation

For an MCP server, install these in your Next.js app:

```bash
npm install @clerk/mcp-tools @clerk/nextjs mcp-handler @modelcontextprotocol/server zod
```

The server runs on `mcp-handler` 2.x, which uses `@modelcontextprotocol/server` 2.1 or later and `zod` 4.2 or later. `withMcpAuth` verifies tokens with `clerkClient` from `@clerk/nextjs`, so an app that passes its own `verifyToken` can leave `@clerk/nextjs` out.

By default the handlers read two environment variables:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

An MCP-only route doesn't need `clerkMiddleware()` in `middleware.ts` (`proxy.ts` in Next.js 16) or `<ClerkProvider>`: `withMcpAuth` verifies the bearer token itself. If your app has `clerkMiddleware()` for its other pages, it must not protect the MCP route or the `/.well-known/oauth-protected-resource` routes: leave them out of `auth.protect()`, so MCP clients get the challenge and metadata from these handlers instead of a sign-in redirect.

## Quick Start

### Building an MCP Server

For a complete working example of an MCP server built with Next.js and Clerk authentication, see the [MCP Next.js Example](https://github.com/clerk/mcp-nextjs-example).

Here's the basic structure you'll need:

#### 1. Shared Options

The MCP endpoint and its metadata live in separate route files, so export their options from one module and import it in both. The metadata then lists the scopes `withMcpAuth` requires as `scopes_supported`, and its `resource` is the URL `withMcpAuth` checks.

```ts
// lib/mcp.ts
import type { McpAuthOptions } from '@clerk/mcp-tools/next';

export const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
} satisfies McpAuthOptions;
```

#### 2. Protected Resource Metadata

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import { metadataCorsHandler, protectedResourceMetadataHandler } from '@clerk/mcp-tools/next';
import { mcpAuthOptions } from '@/lib/mcp';

const handler = protectedResourceMetadataHandler(mcpAuthOptions);
// Answers the CORS preflight of browser-based MCP clients
const corsHandler = metadataCorsHandler();

export { handler as GET, corsHandler as OPTIONS };
```

#### 3. MCP Endpoint

```ts
// app/mcp/route.ts
import { isClerkAuthInfo, withMcpAuth } from '@clerk/mcp-tools/next';
import { createMcpHandler } from 'mcp-handler';
import { mcpAuthOptions } from '@/lib/mcp';

const handler = createMcpHandler((server) => {
  server.registerTool(
    'whoami',
    { description: 'Returns the ID of the Clerk user that authorized this request' },
    async (ctx) => {
      // The auth info `withMcpAuth` verified. `isClerkAuthInfo` narrows it so `extra.userId` is typed.
      const authInfo = ctx.http?.authInfo;
      if (!isClerkAuthInfo(authInfo)) {
        return { content: [{ type: 'text', text: 'Not signed in' }], isError: true };
      }
      // `authInfo.token` is the bearer token, so return only the user ID
      return { content: [{ type: 'text', text: authInfo.extra.userId }] };
    },
  );
});

const authHandler = withMcpAuth(handler, mcpAuthOptions);

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
```

Tools read the verified auth info as `ctx.http?.authInfo`, as `@modelcontextprotocol/server` 2.x passes it. It is `undefined` for a request that [`publicAccess`](#public-access) let through without a token, and with `verifyToken` it is whatever your function returns, so `isClerkAuthInfo` is `false` there.

**Note**: This implementation uses Vercel's `mcp-handler` 2.x, which is specifically designed for Next.js applications and runs on `@modelcontextprotocol/server`. Import `withMcpAuth` from `@clerk/mcp-tools/next` instead of `mcp-handler`: it takes the route handler and an options object instead of a verifier function, and verifies tokens with Clerk unless you pass `verifyToken`.

#### 4. CORS for browser-based MCP clients

Neither `withMcpAuth` nor `mcp-handler` sets CORS headers on the MCP route. A browser-based client, such as MCP Inspector, needs the response to expose `WWW-Authenticate`, or it can't read the `401` challenge that points it to the metadata. It also sends `Authorization`, `Content-Type`, and, after `initialize`, `Mcp-Protocol-Version`, so the preflight must allow those request headers. To serve those clients, add the headers in `app/mcp/route.ts` and answer the preflight, which carries no token, before `withMcpAuth`:

```ts
// app/mcp/route.ts, in place of the export above
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
};

async function corsAuthHandler(req: Request) {
  const response = await authHandler(req);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export {
  corsAuthHandler as GET,
  corsAuthHandler as POST,
  corsAuthHandler as DELETE,
  preflight as OPTIONS,
};
```

### `withMcpAuth(handler, options)`

Wraps a Next.js MCP route handler so that every request needs a valid bearer token. By default Clerk verifies the OAuth access token, including that its `aud` claim includes `resourceUrl`. Pass `verifyToken` to verify tokens with your own function instead. It takes the same options as `mcpAuth` in the Express and Hono adapters, plus `onAuthFailure`.

**Options:**

- `resourceUrl: string | string[]` - Required unless you pass `verifyToken`. The exact URL clients use for this endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one for each origin, for a server that answers on several hostnames. With a list, a request uses the URL with its origin as the audience, so a token issued for one listed URL doesn't pass on another, and a request to any other origin gets a `421 Misdirected Request`. A single URL is used whatever origin the request has, so it works behind a proxy as it is. Only a list is matched against the request's origin, which comes from `req.url`. On Vercel that is the public URL, but a self-hosted app behind a proxy that terminates TLS or rewrites `Host` can see another origin, and then every request gets a `421`: rebuild the request URL from `X-Forwarded-*` headers you trust before calling the wrapped handler. Never list the internal URLs: each listed URL is an audience and a metadata `resource`, and clients connect to the public one. With `verifyToken` and without `resourceUrl`, the URL comes from the request. Pass the same value to the protected resource metadata route, as in `protectedResourceMetadataHandler({ resourceUrl })`, so its `resource` is the URL checked here.
- `requiredScopes?: string[]` - The scopes every request needs. A token without them gets a `403` with `error="insufficient_scope"` and a `scope` that lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry. The `401` challenge lists them in its `scope`. The `403` asks for those scopes by name, so enable each `requiredScopes` and `challengeScopes` entry for the OAuth application in Clerk: a scope it can't be granted is missing from the new token too, and the client gets the `403` again.
- `challengeScopes?: string[]` - More scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them. When a token lacks a `requiredScopes` entry, the `403` lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry. List each tool's `requireAdditionalScopes` scopes here to have the client reauthorize once instead of twice. A token that lacks only `challengeScopes` entries is let through.
- `publicAccess?: PublicAccess` - What a request without a token may do: `methods` (`true`, or a list of protocol methods), `tools` (tool names), and `resources` and `prompts` (`true`, or a list of resource URIs or prompt names). Without it, every such request gets the `401`. See [Public access](#public-access).
- `clerkClient?` - The client that verifies tokens. Defaults to `clerkClient` from `@clerk/nextjs/server`, which reads `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; it is loaded on the first request, so an app that only uses `verifyToken` builds without `@clerk/nextjs` installed. Without `@clerk/nextjs`, every request on the Clerk path throws a `Clerk error:` asking you to install it, and without either variable, every such request, with or without a token, throws a `Clerk error:` that names it. Pass a client created with both `secretKey` and `publishableKey` to verify with another instance, or a function that returns one (or a promise of one), which is called once per request. A value without `authenticateRequest` throws a `Clerk error:` when `withMcpAuth` is called. A client from `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check. Not allowed together with `verifyToken`.
- `verifyToken?: (token: string, req: Request) => AuthInfo | undefined | Promise<AuthInfo | undefined>` - A function that verifies the token in place of Clerk and returns the auth info, or `undefined` to reject it. Throw an `McpTokenVerificationError` to reject it with a reason. It is called with the token first and the request second, the reverse of the `(req, bearerToken)` verifier `mcp-handler`'s `withMcpAuth` takes, so swap the parameters of a verifier you move over.
- `onAuthFailure?: (failure, req) => void` - Synchronously notifies why a request is about to be answered with a `401` or `403` challenge or a `421`, for example for logging. Return values are ignored; a returned promise is not awaited or kept alive after the response. `failure.reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`. For a token Clerk or `verifyToken` rejected with a reason, `failure.cause` is an `McpTokenVerificationError`, whose `code` is Clerk's reason and whose `message` says which check failed. The Express and Hono adapters record the same value on the request context instead.

For asynchronous logging, schedule the work with [`after()`](https://nextjs.org/docs/app/api-reference/functions/after) so Next.js keeps it alive after the response without delaying the challenge. Do not pass an async function directly: TypeScript allows it in a `void` callback position, but that does not extend the request's lifetime.

```ts
import { after } from 'next/server';
import { withMcpAuth } from '@clerk/mcp-tools/next';
import { mcpAuthOptions } from '@/lib/mcp';
import { logAuthFailure } from '@/lib/logging';

const authHandler = withMcpAuth(handler, {
  ...mcpAuthOptions,
  onAuthFailure(failure, req) {
    after(() => logAuthFailure(failure, req));
  },
});
```

A missing or rejected token gets a `401` challenge, and a token without `requiredScopes` gets a `403` `insufficient_scope` challenge. The verified auth info reaches tools as `ctx.http?.authInfo`, with `resourceMetadataUrl` set for step-up scope challenges. When Clerk cannot verify an opaque token at all, for example during an outage, when Clerk rate-limits the server, or with an invalid secret key, the handler answers with a JSON `{"error":"server_error"}` and the `429` or `5xx` status Clerk's Backend API answered with, or `500`, so clients keep their valid token, and logs the `McpAuthError` (exported from `@clerk/mcp-tools/next`, with `reason: 'verification_failed'` and the underlying error as its `cause`) with `console.error`. It is the answer the Express and Hono adapters give. The handler answers it itself, so Next.js's `onRequestError` doesn't see it. A Backend API `4xx` other than `401` and `429` means Clerk refused the token, so it gets the `401` challenge. A JWT access token gets the server error when Clerk's signing keys can't be loaded. With current `@clerk/backend` releases that is only when the request for the signing keys is answered with an error status and a JSON body: they report every other failure to load the signing keys, such as an invalid secret key, a network error, or an error page that is not JSON, as they report an invalid signature, so the client gets the `401` `invalid_token` challenge and authorizes again. Once clerk/javascript#10826 ships, `@clerk/backend` reports those failures as `jwk-remote-failed-to-load`, and each of them gets the server error.

Your Clerk instance must issue the `aud` claim. Clerk turns it on when you add your first MCP server to the instance in the Clerk Dashboard; see [Build an MCP server](https://clerk.com/docs/guides/ai/mcp/build-mcp-server). Require `@clerk/nextjs` 7.9.5 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

For any other authorization server, pass `verifyToken` instead of `clerkClient`:

```ts
const authHandler = withMcpAuth(handler, {
  verifyToken: async (token, req) => verifyMyToken(token),
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['read'],
});
```

### Public access

`publicAccess` lets a client connect and call the tools you list without a token, and sign in only when it reaches something protected. Add it to the options `withMcpAuth` takes:

```ts
// lib/mcp.ts
import type { McpAuthOptions } from '@clerk/mcp-tools/next';

export const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  publicAccess: { methods: true, tools: ['search_docs'] },
} satisfies McpAuthOptions;
```

Tools see `ctx.http?.authInfo` as `undefined` for a request that `publicAccess` let through. See [Public access](../README.md#public-access-sign-in-only-when-needed) in the main guide for every rule.

### Building an MCP Client

For a complete working example of an MCP client implementation, see the [MCP Demo](https://github.com/clerk/mcp-demo) which shows a full client/server setup.

The MCP client functionality uses the core `@clerk/mcp-tools/client` utilities. For detailed examples of client implementation patterns, see the [main README's client guide](../README.md#guide-building-a-client) and the working demo above.

Key Next.js-specific patterns include:

### `protectedResourceMetadataHandler`

Next.js route handler that returns OAuth protected resource metadata for Clerk integration, as defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728). For another authorization server, see [With Custom Authentication](#with-custom-authentication).

**Example:**

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import { protectedResourceMetadataHandler } from '@clerk/mcp-tools/next';

const handler = protectedResourceMetadataHandler({ resourceUrl: 'https://mcp.example.com/mcp' });

export { handler as GET };
```

This handler automatically uses your `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` environment variable. A value that isn't a Clerk publishable key throws a `Clerk error:` naming the variable.

**Options:** the options you pass to `withMcpAuth`, all optional, plus `properties`, so one object, exported from a shared module such as `lib/mcp.ts`, can be passed to both. The handler ignores `clerkClient`, `verifyToken`, and `onAuthFailure`.

- `resourceUrl: string | string[]` (optional) - The same value you pass to `withMcpAuth`: the exact URL clients use for the endpoint, or a list of them, one for each origin. The metadata's `resource` is then the URL `withMcpAuth` checks for the same request, and with a list a request to an origin none of them has gets a `421 Misdirected Request`.
- `requiredScopes?: string[]` and `challengeScopes?: string[]` - The same values you pass to `withMcpAuth`. The metadata lists `requiredScopes` then `challengeScopes`, each once, as `scopes_supported`, and leaves `scopes_supported` out when there are none.
- `properties: Record<string, unknown>` (optional) - Additional metadata, such as `resource_name`. It overrides the generated metadata, except `resource`, which it can't set: pass the URL as `resourceUrl`, so `resource` is the URL `withMcpAuth` checks (RFC 9728 section 3.3). Setting it throws a `Clerk error:` when the handler is created. A `scopes_supported` here is used as given, to list more scopes than the server asks for, but it must include every `requiredScopes` and `challengeScopes` entry, or the handler throws a `Clerk error:` naming the missing ones when it is created.

Without `resourceUrl`, the metadata's `resource` comes from the route path and query, so `/.well-known/oauth-protected-resource/mcp` describes `<origin>/mcp`, `/.well-known/oauth-protected-resource/mcp/` describes `<origin>/mcp/`, and the root describes the bare origin, as RFC 9728 section 3 builds the metadata URL. MCP clients reject metadata whose `resource` differs from the URL they connect to, so if clients reach the endpoint through another public URL than the app sees, pass that exact URL as `resourceUrl`.

### `authorizationServerMetadataHandler`

Next.js route handler for OAuth 2.0 Authorization Server Metadata endpoint based on [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414).

**Example:**

```ts
// app/.well-known/oauth-authorization-server/route.ts
import { authorizationServerMetadataHandler } from '@clerk/mcp-tools/next';

const handler = authorizationServerMetadataHandler();

export { handler as GET };
```

### `metadataCorsHandler`

CORS options request handler for OAuth metadata endpoints. Necessary for MCP clients that operate in web browsers.

**Example:**

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import { protectedResourceMetadataHandler, metadataCorsHandler } from '@clerk/mcp-tools/next';

const handler = protectedResourceMetadataHandler({ resourceUrl: 'https://mcp.example.com/mcp' });
const corsHandler = metadataCorsHandler();

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

  const { client, connect } = await getMcpClientBySessionId({
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

For custom authentication systems, verify tokens with `withMcpAuth` and a `verifyToken` option, and serve the metadata from your own route with `generateProtectedResourceMetadata`. Pass it the same `resourceUrl` you pass to `withMcpAuth`:

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import {
  generateProtectedResourceMetadata,
  metadataCorsHandler,
  metadataCorsHeaders,
} from '@clerk/mcp-tools/next';

export function GET() {
  return Response.json(
    generateProtectedResourceMetadata({
      authServerUrl: 'https://your-auth-server.com',
      resourceUrl: 'https://mcp.example.com/mcp',
    }),
    { headers: metadataCorsHeaders },
  );
}

export const OPTIONS = metadataCorsHandler();
```

## Session Management and Stores

Next.js applications, especially when deployed to serverless environments, require persistent storage for MCP sessions.

For detailed information about available stores and their configurations, see the [Stores section in the main README](../README.md#stores).

The key consideration for Next.js applications is choosing a store that works well with serverless deployments:

- **Development**: Use `createFsStore()` for local development
- **Production**: Use Redis, Postgres, or SQLite stores for persistent session storage

## App Router only

These handlers are App Router route handlers: they take a Web `Request` and return a `Response`. The Pages Router's `req`/`res` API routes aren't supported.

## Working Examples

For complete working examples, see these repositories:

- **[MCP Next.js Server Example](https://github.com/clerk/mcp-nextjs-example)** - A minimal example of an MCP server endpoint using Next.js and Clerk for authentication
- **[MCP Demo](https://github.com/clerk/mcp-demo)** - Example implementation of a full MCP flow using the latest spec draft, including both client and server components

These examples demonstrate real-world implementations and can serve as starting points for your own MCP integrations.
