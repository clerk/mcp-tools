# MCP Tools - Next.js Integration

Next.js utilities for building both MCP servers and clients with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your Next.js applications and build AI applications that can connect to MCP services.

## Installation

For an MCP server, install these in your Next.js app:

```bash
npm install @clerk/mcp-tools @clerk/nextjs mcp-handler @modelcontextprotocol/server zod
```

The server runs on `mcp-handler` 2.x with `@modelcontextprotocol/server` 2.3.0 or later, this package's minimum for SDK 2.x (`mcp-handler` itself accepts any 2.x release), and `zod` 4.2 or later. `clerkInstrumentHandler` verifies tokens with `clerkClient` from `@clerk/nextjs`, so an app that passes its own `verifyToken` can leave `@clerk/nextjs` out.

By default the handlers read two environment variables:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

An MCP-only route doesn't need `clerkMiddleware()` in `middleware.ts` (`proxy.ts` in Next.js 16) or `<ClerkProvider>`: `clerkInstrumentHandler` verifies the bearer token itself. If your app has `clerkMiddleware()` for its other pages, it must not protect the MCP route or the `/.well-known/oauth-protected-resource` routes: leave them out of `auth.protect()`, so MCP clients get the challenge and metadata from these handlers instead of a sign-in redirect.

## Quick Start

### Building an MCP Server

For a complete working example of an MCP server built with Next.js and Clerk authentication, see the [MCP Next.js Example](https://github.com/clerk/mcp-nextjs-example).

Here's the basic structure you'll need:

#### 1. Shared Options

The MCP endpoint and its metadata live in separate route files, so export their options from one module and import it in both. The metadata then lists the scopes `clerkInstrumentHandler` requires as `scopes_supported`, and its `resource` is the URL `clerkInstrumentHandler` checks.

```ts
// lib/mcp.ts
import type { McpAuthOptions } from '@clerk/mcp-tools/next';

export const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
  reporting: true,
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

The endpoint takes two calls from this package: `clerkInstrumentHandler` around the route, which authenticates each request, and `clerkInstrumentServer` in the `mcp-handler` callback, which lets Clerk [report the server's MCP activity](#reporting-mcp-activity).

```ts
// app/mcp/route.ts
import {
  clerkInstrumentHandler,
  clerkInstrumentServer,
  isClerkAuthInfo,
} from '@clerk/mcp-tools/next';
import { createMcpHandler } from 'mcp-handler';
import { mcpAuthOptions } from '@/lib/mcp';

const handler = createMcpHandler((server) => {
  clerkInstrumentServer(server);

  server.registerTool(
    'whoami',
    { description: 'Returns the ID of the Clerk user that authorized this request' },
    async (ctx) => {
      // The auth info `clerkInstrumentHandler` verified. `isClerkAuthInfo` narrows it so `extra.userId` is typed.
      const authInfo = ctx.http?.authInfo;
      if (!isClerkAuthInfo(authInfo)) {
        return { content: [{ type: 'text', text: 'Not signed in' }], isError: true };
      }
      // `authInfo.token` is the bearer token, so return only the user ID
      return { content: [{ type: 'text', text: authInfo.extra.userId }] };
    },
  );
});

const authedHandler = clerkInstrumentHandler(handler, mcpAuthOptions);

export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
```

Tools read the verified auth info as `ctx.http?.authInfo`, as `@modelcontextprotocol/server` 2.x passes it. It is `undefined` for a request that [`discoverable` or `publicAccess`](#public-access) let through without a token, and with `verifyToken` it is whatever your function returns, so `isClerkAuthInfo` is `false` there.

**Note**: This implementation uses Vercel's `mcp-handler` 2.x, which is specifically designed for Next.js applications and runs on `@modelcontextprotocol/server`. Use `clerkInstrumentHandler` from `@clerk/mcp-tools/next` in place of `mcp-handler`'s `withMcpAuth`: it takes the route handler and an options object instead of a verifier function, and verifies tokens with Clerk unless you pass `verifyToken`. It also serves the handler `createMcpHandler` from `@modelcontextprotocol/server` returns, for a route without `mcp-handler`.

#### 4. CORS for browser-based MCP clients

Neither `clerkInstrumentHandler` nor `mcp-handler` sets CORS headers on the MCP route. A browser-based client, such as MCP Inspector, needs the response to expose `WWW-Authenticate`, or it can't read the `401` challenge that points it to the metadata. It also sends `Authorization`, `Content-Type`, `Mcp-Protocol-Version`, and the [standard request headers](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#standard-request-headers) of the 2026-07-28 transport: `Mcp-Method` on every request, and `Mcp-Name` on `tools/call`, `resources/read`, and `prompts/get`. The preflight must allow all of them. If a tool marks a parameter with `x-mcp-header`, clients also send its `Mcp-Param-{Name}` header; add each of those names to the allowed headers too. To serve those clients, add the headers in `app/mcp/route.ts` and answer the preflight, which carries no token, before `clerkInstrumentHandler`:

```ts
// app/mcp/route.ts, in place of the export above
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Method, Mcp-Name',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
};

async function corsAuthedHandler(req: Request) {
  const response = await authedHandler(req);
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
  corsAuthedHandler as GET,
  corsAuthedHandler as POST,
  corsAuthedHandler as DELETE,
  preflight as OPTIONS,
};
```

### `clerkInstrumentHandler(handler, options)`

Wraps a Next.js MCP route handler so that every request needs a valid bearer token: the route handler `createMcpHandler` from `mcp-handler` returns, the handler `createMcpHandler` from `@modelcontextprotocol/server` returns, or a function `(req, { authInfo }) => Response`. By default Clerk verifies the OAuth access token, including that its `aud` claim includes `resourceUrl`. Pass `verifyToken` to verify tokens with your own function instead. It takes the same options as `clerkInstrumentHandler` in the Express and Hono adapters, plus `onAuthFailure`.

`withClerkMcpAuth(handler, options)`, which it replaces, is deprecated. It takes the same options except `reporting`, which it refuses with a `Clerk error:`.

**Options:**

- `resourceUrl: string | string[]` - Required unless you pass `verifyToken`. The exact URL clients use for this endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one for each origin, for a server that answers on several hostnames. With a list, a request uses the URL with its origin as the audience, so a token issued for one listed URL doesn't pass on another, and a request to any other origin gets a `421 Misdirected Request`. A single URL is used whatever origin the request has, so it works behind a proxy as it is. Only a list is matched against the request's origin, which comes from `req.url`. On Vercel that is the public URL. A self-hosted app, under `next start` or the standalone server, sees the address the server listens on, such as `http://localhost:3000`, whatever `Host` the client sent, with or without a proxy, and then every request gets a `421`. There, use a single URL, or rebuild the request URL before calling the wrapped handler: from the `Host` header when clients connect to the app directly, or from `X-Forwarded-Host` and `X-Forwarded-Proto` set by a proxy you trust. Never list the internal URLs: each listed URL is an audience and a metadata `resource`, and clients connect to the public one. With `verifyToken`, set `resourceUrl` for the verifier's reported `resource` to be checked, and pass the same value to the protected resource metadata route, as in `protectedResourceMetadataHandler({ resourceUrl })`. Without `resourceUrl`, a URL derived from the request is used only to locate metadata and is not checked against the verifier's reported `resource`.
- `requiredScopes?: string[]` - The scopes every request needs. A token without them gets a `403` with `error="insufficient_scope"` and a `scope` that lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry. The `401` challenge lists them in its `scope`. The `403` asks for those scopes by name, so enable each `requiredScopes` and `challengeScopes` entry for the OAuth application in Clerk: a scope it can't be granted is missing from the new token too, and the client gets the `403` again.
- `challengeScopes?: string[]` - More scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them. When a token lacks a `requiredScopes` entry, the `403` lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry. List each tool's `requireAdditionalScopes` scopes here to have the client reauthorize once instead of twice. A token that lacks only `challengeScopes` entries is let through.
- `discoverable?: boolean` - What a request without a token may list: `true`, the default, lets anyone connect and list the tools, resources, resource templates, and prompts; `false` requires a token for every MCP request. Protected resource metadata and the Server Card are public either way. See [Public access](#public-access).
- `publicAccess?: PublicAccess` - What else a request without a token may do: `tools` (tool names), and `resources` and `prompts` (`true`, or a list of resource URIs or prompt names), on top of what `discoverable` opens. See [Public access](#public-access).
- `clerkClient?` - The client that verifies tokens. Defaults to `clerkClient` from `@clerk/nextjs/server`, which reads `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; it is loaded on the first request, so an app that only uses `verifyToken` builds without `@clerk/nextjs` installed. Without `@clerk/nextjs`, every request on the Clerk path throws a `Clerk error:` asking you to install it, and without either variable, every such request, with or without a token, throws a `Clerk error:` that names it. An app that passes `secretKey` and `publishableKey` to `clerkMiddleware()` instead, or runs in keyless mode, has neither variable set, so it passes `clerkClient: () => clerkClient()` with `clerkClient` from `@clerk/nextjs/server`, and keeps the MCP route in the middleware's `matcher` (left out of `auth.protect()`) so that client gets the middleware's keys. Pass a client created with both `secretKey` and `publishableKey` to verify with another instance, or a function that returns one (or a promise of one), which is called once per request. A value without `authenticateRequest` throws a `Clerk error:` when `clerkInstrumentHandler` is called. A client from `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check. Not allowed together with `verifyToken`.
- `verifyToken?: (token: string, req: Request) => AuthInfo | undefined | Promise<AuthInfo | undefined>` - A function that verifies the token in place of Clerk and returns the auth info, or `undefined` to reject it. The result must have a finite `expiresAt`, in seconds since the epoch, and a non-empty `clientId`, or the token gets the `401` `invalid_token` challenge, with an `McpTokenVerificationError` cause whose `code` is `token-claims-missing` and whose `message` names the missing field. [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-handling), 2025-06-18 and later, has servers validate tokens as [OAuth 2.1 section 5.2](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5.2) describes, which includes checking that the token is not expired, and [RFC 9068 section 2.2](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2) makes `exp` and `client_id` REQUIRED in a JWT access token. JWT libraries such as `jsonwebtoken` and `jose` check `exp` only when the token has one, so pass it through as `expiresAt`. Auth info from `toClerkAuthInfo` is treated as Clerk-verified, so it passes without an `expiresAt` or a `clientId`, since Clerk checks those itself: build it only from a request state returned by `authenticateRequest(req, { acceptsToken: 'oauth_token', audience: resourceUrl })`, using `requestState.toAuth()`, never from `auth({ acceptsToken: 'oauth_token' })` alone, a cached result, or a hand-built one. Otherwise use the built-in Clerk path, `clerkInstrumentHandler(handler, { clerkClient, resourceUrl })`. Catch the errors your JWT library throws for a token it rejects, such as `JWTExpired` from `jose` or `TokenExpiredError` from `jsonwebtoken`, and return `undefined` or throw an `McpTokenVerificationError`, which rejects it with a reason, so the token gets the `401` `invalid_token` challenge, which [RFC 6750 section 3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1) gives an expired or invalid token, and the client can get a new one. Any other error the function throws means the token could not be verified at all: it gets the JSON `{"error":"server_error"}` answer, with a `500` unless the error has a `429` or `5xx` `status`, and the client keeps the token. It is called with the token first and the request second, the reverse of the `(req, bearerToken)` verifier `mcp-handler`'s `withMcpAuth` takes, so swap the parameters of a verifier you move over.
- `reporting?: boolean | ReportingOptions` - `true`, or an options object, to report MCP activity to Clerk: tool calls, auth failures, and initialize, list, resource read and prompt get requests. Off by default. See [Reporting MCP activity](#reporting-mcp-activity).
- `onAuthFailure?: (failure, req) => void` - Synchronously notifies why a request is about to be answered with a `401` or `403` challenge or a `421`, for example for logging. Return values are ignored; a returned promise is not awaited or kept alive after the response. `failure.reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`. For a token Clerk or `verifyToken` rejected with a reason, `failure.cause` is an `McpTokenVerificationError`, whose `code` is Clerk's reason and whose `message` says which check failed. The Express and Hono adapters record the same value on the request context instead.

Unknown option keys, such as `requiredScope` instead of `requiredScopes`, throw a `Clerk error:` at setup rather than being ignored. Setting both `clerkClient` and `verifyToken` also throws: choose Clerk verification with `clerkClient` and `resourceUrl`, or your own `verifyToken`. `properties` belongs only to `protectedResourceMetadataHandler`. `onAuthFailure` remains supported.

For asynchronous logging, schedule the work with [`after()`](https://nextjs.org/docs/app/api-reference/functions/after) so Next.js keeps it alive after the response without delaying the challenge. Do not pass an async function directly: TypeScript allows it in a `void` callback position, but that does not extend the request's lifetime.

```ts
import { after } from 'next/server';
import { clerkInstrumentHandler } from '@clerk/mcp-tools/next';
import { mcpAuthOptions } from '@/lib/mcp';
import { logAuthFailure } from '@/lib/logging';

const authedHandler = clerkInstrumentHandler(handler, {
  ...mcpAuthOptions,
  onAuthFailure(failure, req) {
    after(() => logAuthFailure(failure, req));
  },
});
```

A missing or rejected token gets a `401` challenge, and a token without `requiredScopes` gets a `403` `insufficient_scope` challenge. The verified auth info reaches tools as `ctx.http?.authInfo`, with `resourceMetadataUrl` set for step-up scope challenges. When Clerk cannot verify an opaque token at all, for example during an outage, when Clerk rate-limits the server, or with an invalid secret key, the handler answers with a JSON `{"error":"server_error"}` and the `429` or `5xx` status Clerk's Backend API answered with, or `500`, so clients keep their valid token, and logs the `McpAuthError` (exported from `@clerk/mcp-tools/next`, with `reason: 'verification_failed'` and the underlying error as its `cause`) with `console.error`. It is the answer the Express and Hono adapters give. The handler answers it itself, so Next.js's `onRequestError` doesn't see it. A Backend API `4xx` other than `401` and `429` means Clerk refused the token, so it gets the `401` challenge. A JWT access token gets the server error when Clerk's signing keys can't be loaded. With current `@clerk/backend` releases that is only when the request for the signing keys is answered with an error status and a JSON body: they report every other failure to load the signing keys, such as an invalid secret key, a network error, or an error page that is not JSON, as they report an invalid signature, so the client gets the `401` `invalid_token` challenge and authorizes again. Once clerk/javascript#10826 ships, `@clerk/backend` reports those failures as `jwk-remote-failed-to-load`, and each of them gets the server error.

Your Clerk instance must issue the `aud` claim. Clerk turns it on when you add your first MCP server to the instance in the Clerk Dashboard. The client must send `resource` matching `resourceUrl` when requesting a token. The first Clerk audience rejection (missing, invalid, or mismatched `aud`) logs a `Clerk warning:` once per auth middleware instance, explaining the Dashboard setup, `resource`, and backend minimum without logging the token or its claims. See [Build an MCP server](https://clerk.com/docs/guides/ai/mcp/build-mcp-server). Require `@clerk/nextjs` 7.9.5 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

For any other authorization server, pass `verifyToken` instead of `clerkClient`:

```ts
const authedHandler = clerkInstrumentHandler(handler, {
  // Returns the auth info, with the token's `expiresAt` and `clientId`, or catches its JWT library's errors and
  // returns `undefined` for a token it rejects
  verifyToken: async (token, req) => verifyMyToken(token),
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['read'],
});
```

### Public access

A server is discoverable by default, so a client can connect and list without a token. `publicAccess` lets it call the tools you list as well, and it signs in only when it reaches something protected. Add it to the options `clerkInstrumentHandler` takes:

```ts
// lib/mcp.ts
import type { McpAuthOptions } from '@clerk/mcp-tools/next';

export const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  publicAccess: { tools: ['search_docs'] },
} satisfies McpAuthOptions;
```

Tools see `ctx.http?.authInfo` as `undefined` for a request that `discoverable` or `publicAccess` let through. Set `discoverable: false` to require a token for every request. See [Public access](../README.md#public-access-sign-in-only-when-needed) in the main guide for every rule.

### Reporting MCP activity

With `reporting`, Clerk records each tool call your MCP server answers: the tool, whether it succeeded, how long it took, and who called it. The calls show up in your instance's MCP analytics and audit log. Tool arguments and results are never sent.

It takes both calls from the [MCP Endpoint](#3-mcp-endpoint):

- `clerkInstrumentHandler(handler, { ...options, reporting: true })` around the route knows who made each request.
- `clerkInstrumentServer(server)` in the `mcp-handler` callback sees each tool call and the other requests below. It replaces `connect` on that server object only, and changes nothing a client sees. Call it before registering tools, resources, and prompts: it also wraps `registerTool`, `registerResource`, and `registerPrompt`, and `tool`, `resource`, and `prompt` on MCP SDK 1.x, to time each handler, tell a throw from a returned error, and name each resource read by the resource it matched. Anything registered before it, or whose callback is replaced with `update({ callback })`, is reported without them.

A POST whose server was never passed to `clerkInstrumentServer` logs a one-time `Clerk warning:`, and so does an instrumented server answering a call that the deprecated `withClerkMcpAuth` authenticated.

Each report has:

- The tool's name, the server's name, whether the call succeeded, how long it took and how long its handler ran, and when it was made. A failed call also has its error code: the `_meta['clerk.com/error_code']` of an error result, as the prebuilt tools set it, `thrown:<ErrorClass>` for a handler that threw, with the error's class name and never its message, or `jsonrpc:<code>` for a JSON-RPC error. A call to a tool the `McpServer` does not have fails with `not_found`; a low-level `Server` keeps no list of its tools, so its calls keep the code of the response.
- Other requests, each as its own report: each `initialize`, with the client's name and version and the protocol version it asked for and got, or, on protocol revision 2026-07-28, which has no `initialize`, each `server/discover`, with the client and protocol version from its `_meta`; each `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`, and `tasks/list`, with its item count; each resource read, by the name of the registered resource it matched, and a template's URI template, or by the URI's scheme alone, and never by the URI asked for; and each prompt get, by the prompt's name, with its message count. Resource reads and prompt gets have the same outcome, error code, and times as tool calls, and one for a resource or prompt that isn't registered fails with `not_found`. Prompt arguments and resource contents are never sent. A client on 2026-07-28 that never sends `server/discover`, which the spec leaves optional for clients, is not reported as a connected client, though its other requests are.
- The Clerk user ID, OAuth client ID, access token ID, and organization ID, for a token Clerk verified. A token `verifyToken` verified sends none of them.
- The request's MCP protocol version: the one its `_meta` names on protocol revision 2026-07-28, or the one the same server object negotiated in `initialize`. A server created for each request, as `createMcpHandler` does, never sees that `initialize`, so its reports on earlier revisions have none. An auth failure carries only a version its body's `_meta` names.
- A hash of the request's MCP session: the first 32 hex digits of the SHA-256 of `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and the `Mcp-Session-Id` header, so the reports of one session can be grouped. The session ID itself is never sent. A request without that header or key, or with a session ID longer than 256 characters, has none, and neither does an `initialize`, which comes before the session. Auth failures carry it too.
- The client's IP address, from `x-real-ip` on Vercel, which sets that header itself. A self-hosted app sends none unless you pass an `ipAddress` function.
- The client's `User-Agent`, up to 512 characters.

Pass an options object instead of `true` to turn fields off, or to choose which tools are reported:

```ts
// lib/mcp.ts
export const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  reporting: {
    ipAddress: (req) => req.headers.get('x-forwarded-for')?.split(',')[0],
    userAgent: false,
    identity: false,
    tools: (toolName) => toolName !== 'healthcheck',
    serverName: 'acme-production',
  },
} satisfies McpAuthOptions;
```

- `ipAddress` - `true`, the default, sends `x-real-ip` on Vercel. `false` sends none, and a function `(req) => string | undefined` returns the address yourself, from a header your proxy sets. A value that isn't an IP address is not sent.
- `userAgent` and `identity` - `false` leaves out the `User-Agent`, or the user, OAuth client, access token, and organization IDs. Both default to `true`.
- `tools` - `(toolName) => boolean`. A call to a tool it returns `false` for is not reported.
- `serverName` - The server name to report. Defaults to the name the server was created with, the `serverInfo` you give `createMcpHandler`.
- `secretKey` - The secret key of the instance the reports belong to. Defaults to `CLERK_SECRET_KEY`.
- `apiUrl` - The Backend API origin. Defaults to `CLERK_API_URL`, then `https://api.clerk.com`.
- `fetch` - Sends the reports. Defaults to the global `fetch`.

Unknown keys and invalid values throw a `Clerk error:` when the route module loads. Reports go to the Backend API's `POST /v1/mcp_events` once the response is over, with [`after()`](https://nextjs.org/docs/app/api-reference/functions/after), so a serverless function keeps running until they are sent. Sending them never delays or fails an MCP request: a batch the Backend API refuses, or that can't reach it, is dropped with a one-time `Clerk warning:`. At most 1,000 reports wait to be sent while the Backend API is slow to answer; past that the oldest are dropped, with a one-time `Clerk warning:`. A call without a token, which `publicAccess` lets through, is not reported.

With `reporting` on, `clerkInstrumentHandler` also reports each request it answers with a `401` or `403` challenge or a `421`, so you can see where agents get stuck before their first call. The report has the `reason` (`missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`), the HTTP status, the verifier's code for a rejected token, such as `token-invalid` (never its message), and the JSON-RPC method and tool name of the request's first message, read from a copy of a JSON body up to 64 KiB, so the request itself is untouched. The `serverName`, `ipAddress` and `userAgent` options apply to it as they do to tool calls, and a tool `tools` returns `false` for is reported without its name. Only a `403` carries the Clerk user, OAuth client, access token, and organization IDs, of the token Clerk verified that lacked the scopes; a `401` or `421` has none. The `400` to a request without a URL and the server error when a token could not be verified at all are not reported. The answer is sent first and the body read afterwards, so reporting never delays it. Since anyone can cause an auth failure, at most 100 a minute are reported for each secret key, and they wait apart from tool calls, so a burst of them never pushes a tool call out. A burst is gathered and sent in one batch about a second later.

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

**Options:** the options you pass to `clerkInstrumentHandler`, all optional, plus `properties`, so the auth options exported from a shared module such as `lib/mcp.ts` can be reused here. Add `properties` only when calling the metadata handler, not `clerkInstrumentHandler`. The handler ignores `clerkClient`, `verifyToken`, `onAuthFailure`, and `reporting`.

- `resourceUrl: string | string[]` (optional) - The same value you pass to `clerkInstrumentHandler`: the exact URL clients use for the endpoint, or a list of them, one for each origin. The metadata's `resource` is then the URL `clerkInstrumentHandler` checks for the same request, and with a list a request to an origin none of them has gets a `421 Misdirected Request`.
- `requiredScopes?: string[]` and `challengeScopes?: string[]` - The same values you pass to `clerkInstrumentHandler`. The metadata lists `requiredScopes` then `challengeScopes`, each once, as `scopes_supported`, and leaves `scopes_supported` out when there are none.
- `properties: Record<string, unknown>` (optional) - Additional metadata, such as `resource_name`. It overrides the generated metadata, except `resource`, which it can't set: pass the URL as `resourceUrl`, so `resource` is the URL `clerkInstrumentHandler` checks (RFC 9728 section 3.3). Setting it throws a `Clerk error:` when the handler is created. A `scopes_supported` here is used as given, to list more scopes than the server asks for, but it must include every `requiredScopes` and `challengeScopes` entry, or the handler throws a `Clerk error:` naming the missing ones when it is created.

Without `resourceUrl`, the metadata's `resource` comes from the route path and query, so `/.well-known/oauth-protected-resource/mcp` describes `<origin>/mcp`, `/.well-known/oauth-protected-resource/mcp/` describes `<origin>/mcp/`, and the root describes the bare origin, as RFC 9728 section 3 builds the metadata URL. MCP clients reject metadata whose `resource` differs from the URL they connect to (RFC 9728 section 3.3), so if clients reach the endpoint through another public URL than the app sees, as they do for a self-hosted `next start` or standalone app, which sees the address it listens on, pass that exact URL as `resourceUrl`.

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

### `serverCardHandler(options)`

Route handler that serves an MCP [Server Card](../README.md#discovery-server-cards). It takes the `generateServerCard` options, with `resourceUrl` as one URL or a list with one for each origin, plus `maxAge`, the seconds the card may be reused before revalidation (default `3600`; `0` for `public, no-cache`). It validates them and generates the card when it is created, throwing a `Clerk error:` for anything the card can't have, so it needs no Clerk keys, `@clerk/nextjs`, or MCP SDK, and later changes to the options change nothing. Importing it adds no route.

Next.js only calls a route's exported methods, so export the one handler for each of them. It answers its own CORS preflight, with the same headers as the other adapters' discovery handlers, so export it as `OPTIONS` too rather than `metadataCorsHandler`. Without an `OPTIONS` export, Next.js answers the preflight itself with no CORS headers, and without the other exports, it answers those methods with a bare `405`:

```ts
// app/mcp/server-card/route.ts
import { serverCardHandler } from '@clerk/mcp-tools/next';

const handler = serverCardHandler({
  name: 'com.example/weather',
  version: '1.2.0',
  description: 'Forecasts and current conditions.',
  resourceUrl: 'https://mcp.example.com/mcp',
});

export {
  handler as GET,
  handler as HEAD,
  handler as OPTIONS,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
```

`GET` and `HEAD` get the card with a weak `ETag` and public caching, a matching `If-None-Match` gets a bodyless `304`, `OPTIONS` the CORS preflight, other methods a `405`, and a request to an origin no listed `resourceUrl` has a `421`. Every error is sent with `Cache-Control: no-store`, so no cache keeps it. As with `clerkInstrumentHandler`, only a list is matched, against the origin of `req.url`; `Host` and `X-Forwarded-*` headers are never read. A self-hosted app under `next start` sees the address it listens on, so use a single URL there. Leave the route out of `auth.protect()` in `clerkMiddleware()`, so clients without a session can read it.

### `aiCatalogHandler(options)`

Route handler that serves an [AI Catalog](../README.md#discovery-ai-catalogs) linking to MCP Server Cards. It takes the `generateAICatalog` options plus `maxAge`, as `serverCardHandler` does. It validates them and generates the catalog when it is created, throwing a `Clerk error:` for anything the catalog can't have, so it needs no Clerk keys or MCP SDK, never fetches the cards it links to, and later changes to the options change nothing. Export it for each method, as `serverCardHandler`, from the route for `/.well-known/ard.json`, and re-export that route from `/.well-known/ai-catalog.json`, so both [catalog paths](../README.md#discovery-ai-catalogs) serve it:

```ts
// app/.well-known/ard.json/route.ts
import { aiCatalogHandler } from '@clerk/mcp-tools/next';

const handler = aiCatalogHandler({
  entries: [
    {
      identifier: 'urn:air:example.com:weather',
      displayName: 'Weather',
      url: 'https://mcp.example.com/mcp/server-card',
    },
  ],
});

export {
  handler as GET,
  handler as HEAD,
  handler as OPTIONS,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
```

```ts
// app/.well-known/ai-catalog.json/route.ts
export { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } from '../ard.json/route';
```

It answers as `serverCardHandler` does, with `application/ai-catalog+json`, and both paths get the same body and headers. The catalog is the same for every request, so it never answers `421`; for several origins, create one handler for each, pick it by `new URL(req.url).origin`, and answer `421` for an origin without one rather than serving another origin's catalog.

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

For custom authentication systems, verify tokens with `clerkInstrumentHandler` and a `verifyToken` option, and serve the metadata from your own route with `generateProtectedResourceMetadata`. Pass it the same `resourceUrl` you pass to `clerkInstrumentHandler`:

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
