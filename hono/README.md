# MCP Tools - Hono Integration

Hono utilities for building MCP servers with authentication support.

## Installation

```bash
npm install @clerk/mcp-tools hono @clerk/backend @modelcontextprotocol/server
# On Node.js, to start the server
npm install @hono/node-server
```

These are optional peer dependencies, so the package manager doesn't install them for you or warn when one is missing. The package is ESM-only: it has no CommonJS build, so import it from an ES module (`"type": "module"` in `package.json`).

`clerkInstrumentHandler` serves the handler `createMcpHandler` from `@modelcontextprotocol/server` 2.3.0 or later returns, or a function of your own that serves a web-standard request with its auth info, such as one on `@modelcontextprotocol/sdk` 1.x. On SDK 2.3.0 or later, its `scopeChallenge` step-up works through the handler; see [Per-tool scopes](#per-tool-scopes).

The tools in `@clerk/mcp-tools/tools`, such as `submitFeedbackTool`, also import `zod` (3.25 or later, or 4), an optional peer dependency. Add it to your app's own dependencies, on the same major version your MCP SDK uses (4.2 or later for SDK 2), even though the SDK depends on it too: a package manager that doesn't hoist dependencies, such as Yarn PnP or pnpm with an isolated layout, can't resolve the SDK's copy from `@clerk/mcp-tools`.

`clerkInstrumentHandler` builds its Clerk client with `createClerkClient` from `@clerk/backend`, from the `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` environment variables, and `CLERK_API_URL`, `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set. It loads the package only when it builds that client, so an app that passes `clerkClient` or `verifyToken` doesn't need it.

## Quick Start

### With Clerk Authentication

An MCP server takes two calls from this package: `clerkInstrumentHandler` on the route, which authenticates each request, and `clerkInstrumentServer` where the server is created, which lets Clerk [report its tool calls](#reporting-tool-calls).

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  type McpAuthOptions,
  authorizationServerMetadataHandler,
  clerkInstrumentHandler,
  clerkInstrumentServer,
  isClerkAuthInfo,
  protectedResourceMetadataHandler,
} from '@clerk/mcp-tools/hono';

// One object for both calls, so the metadata lists the scopes `clerkInstrumentHandler` requires as `scopes_supported`
const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
  reportToolCalls: true,
} satisfies McpAuthOptions;

function createServer() {
  const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
  clerkInstrumentServer(server);

  server.registerTool(
    'whoami',
    { description: 'Returns the ID of the Clerk user that authorized this request' },
    async (ctx) => {
      // Narrows the auth info to the one Clerk verified, so `extra.userId` is a string
      const authInfo = ctx.http?.authInfo;
      if (!isClerkAuthInfo(authInfo)) {
        return { isError: true, content: [{ type: 'text', text: 'Not signed in with Clerk.' }] };
      }
      // `authInfo.token` is the bearer token, so return only the user ID
      return { content: [{ type: 'text', text: authInfo.extra.userId }] };
    },
  );

  return server;
}

const app = new Hono();
// Browser-based MCP clients can only read the challenge if it is exposed
app.use('*', cors({ origin: '*', exposeHeaders: ['WWW-Authenticate'] }));

app.get(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceMetadataHandler(mcpAuthOptions),
);
app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
app.all('/mcp', clerkInstrumentHandler(createMcpHandler(createServer), mcpAuthOptions));

export default app;
```

`export default app` is the form Cloudflare Workers and Bun run. On Node.js, install `@hono/node-server` and start the server instead:

```ts
import { serve } from '@hono/node-server';

serve({ fetch: app.fetch, port: 3000 });
```

Clients can connect and list tools before the user signs in, since a server is discoverable by default. To let them call some tools too, add `publicAccess` to the shared options. A tool you don't list still gets the `401` challenge, and `discoverable: false` requires a token for every request. See [Public access](#public-access).

```ts
const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
  publicAccess: { tools: ['search_docs'] },
} satisfies McpAuthOptions;
```

The MCP route doesn't need `clerkMiddleware()` from `@clerk/hono`. If other routes in your app do, mount it on those routes rather than on `*` or `/mcp`: it verifies the bearer token too, so on the MCP route each token would be verified twice.

On `@modelcontextprotocol/sdk` 1.x, pass a function that serves the request with the SDK's web-standard transport, which takes the auth info `clerkInstrumentHandler` passes as its second argument:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

app.all(
  '/mcp',
  clerkInstrumentHandler(async (request, { authInfo }) => {
    const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
    clerkInstrumentServer(server);
    // Register your tools, resources, and prompts
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { authInfo });
    } finally {
      await server.close();
    }
  }, mcpAuthOptions),
);
```

### With Custom Authentication

```ts
import { Hono } from 'hono';
import { type AuthInfo, McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { clerkInstrumentHandler, generateProtectedResourceMetadata } from '@clerk/mcp-tools/hono';

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
  clerkInstrumentHandler(createMcpHandler(createServer), {
    verifyToken: async (token, c): Promise<AuthInfo | undefined> => {
      // Catches its JWT library's errors and returns `undefined` for a token it rejects
      const user = await verifyMyToken(token);
      if (!user) return undefined;
      return {
        token,
        scopes: user.scopes,
        clientId: user.clientId,
        expiresAt: user.expiresAt,
        extra: { userId: user.id },
      };
    },
    resourceUrl,
  }),
);

export default app;
```

## Reference

### `clerkInstrumentHandler(handler, options)`

A Hono handler that authenticates each MCP request, then serves it with `handler`: the handler `createMcpHandler` from `@modelcontextprotocol/server` returns, or a function `(request, { authInfo }) => Response`. Mount it with `app.all`. It extracts the bearer token from the `Authorization` header, verifies it with Clerk, including that its audience is `resourceUrl`, or with your `verifyToken` function, passes the result to `handler`, and stores it in Hono context (`c.get('mcpAuth')`). Returns `401` with a `WWW-Authenticate` header if the token is missing, malformed, or rejected, adding `error="invalid_token"` for a rejected token. A malformed `Bearer` credential, such as `Bearer a b`, and more than one `Authorization` header get that `401` challenge, not the `400` `invalid_request` that [RFC 6750 section 3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1) recommends for a malformed request, so the client can still start authorization; they are the only departure from that section. Another scheme, such as `Basic`, gets the challenge without an error code, as that section says for an unsupported authentication method.

`mcpAuth(options)`, the middleware it replaces, is deprecated. It takes the same options except `reportToolCalls`, which it refuses with a `Clerk error:`, since it never sees a tool call. Each option below applies to both.

- `reportToolCalls`: `true`, or an options object, to report each tool call to Clerk. Off by default. See [Reporting tool calls](#reporting-tool-calls).
- `resourceUrl`: the exact URL clients use for this endpoint, or a list of them, one for each origin, for a server that answers on several hostnames. Required unless you pass `verifyToken`. With a list, a request uses the URL with its origin, and a request to any other origin gets a `421 Misdirected Request` without a challenge, with `c.get('mcpAuthFailure')` set to `misdirected_request`. Under Clerk verification that URL is the audience, so a token issued for one listed URL doesn't pass on another. For a list, pick the metadata route's `resource` with `matchResourceUrl` from `@clerk/mcp-tools/hono`. The challenge's `resource_metadata` is derived from it. A single URL is used whatever origin the request has, so it works behind a proxy as it is. Only a list is matched against the request's origin, which comes from `c.req.url`: behind a proxy that terminates TLS or rewrites `Host`, as with Node.js behind nginx, that is the origin the app sees, not the public one, and every request gets a `421`. Rebuild the request URL from `X-Forwarded-*` headers you trust before this middleware. Never list the internal URLs: each listed URL is an audience and a metadata `resource`, and clients connect to the public one. With `verifyToken`, set `resourceUrl` for the verifier's reported `resource` to be checked, and pass the same value to the metadata route, as in `protectedResourceMetadataHandler({ resourceUrl })`, or to `generateProtectedResourceMetadata` from `@clerk/mcp-tools/hono` when building your own route. Without `resourceUrl`, a URL derived from the request is used only to locate metadata, can differ from the public URL behind a proxy, and is not checked against the verifier's reported `resource`.
- `requiredScopes`: scopes every request needs. A token without them gets a `403` with `error="insufficient_scope"` and a `scope` that lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry, so the new grant keeps the old access. The `401` challenge lists them in its `scope`. The `403` asks for those scopes by name, so enable each `requiredScopes` and `challengeScopes` entry for the OAuth application in Clerk: a scope it can't be granted is missing from the new token too, and the client gets the `403` again.
- `challengeScopes`: more scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them. When a token lacks a `requiredScopes` entry, the `403` lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry. List each tool's `requireAdditionalScopes` scopes here to have the client reauthorize once instead of twice. A token that lacks only `challengeScopes` entries is let through.
- `discoverable` (optional): What a request without a token may list: `true`, the default, lets anyone connect and list the tools, resources, resource templates, and prompts; `false` requires a token for every MCP request. Protected resource metadata and the Server Card are public either way. See [Public access](#public-access).
- `publicAccess` (optional): what else a request without a token may do: `tools` (tool names), and `resources` and `prompts` (`true`, or a list of resource URIs or prompt names), on top of what `discoverable` opens. See [Public access](#public-access).
- `clerkClient` (optional): the Clerk client that verifies tokens, or a function that returns one (or a promise of one), which is called once per request. A value without `authenticateRequest` throws a `Clerk error:` when `clerkInstrumentHandler` is called. Without it, `clerkInstrumentHandler` builds one with `createClerkClient` from `@clerk/backend`, from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` read through Hono's `env(c)`, so it works on Cloudflare Workers, where they are only on `c.env`. It also passes `CLERK_API_URL`, `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set, as `clerkClient` from `@clerk/express` does. It keeps that client for later requests with the same settings. A missing variable throws a `Clerk error:` that names it, and a missing `@clerk/backend` throws a `Clerk error:` asking you to install it or pass `clerkClient`. `clerkMiddleware()` also verifies the token, so keep it off the MCP route, or each token is verified twice. A client you pass must come from `@clerk/backend` 3.19.0 or later, the first with a reliable audience check. Not allowed together with `verifyToken`.
- `verifyToken` (optional): `(token: string, c: Context) => AuthInfo | undefined | Promise<AuthInfo | undefined>`, a function that verifies the token in place of Clerk and returns the auth data, or `undefined` to reject it. The result must have a finite `expiresAt`, in seconds since the epoch, and a non-empty `clientId`, or the token gets the `401` `invalid_token` challenge, with an `McpTokenVerificationError` cause whose `code` is `token-claims-missing` and whose `message` names the missing field. [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-handling), 2025-06-18 and later, has servers validate tokens as [OAuth 2.1 section 5.2](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5.2) describes, which includes checking that the token is not expired, and [RFC 9068 section 2.2](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2) makes `exp` and `client_id` REQUIRED in a JWT access token. JWT libraries such as `jsonwebtoken` and `jose` check `exp` only when the token has one, so pass it through as `expiresAt`. Auth info from `toClerkAuthInfo` is treated as Clerk-verified, so it passes without an `expiresAt` or a `clientId`, since Clerk checks those itself: build it only from a request state returned by `authenticateRequest(req, { acceptsToken: 'oauth_token', audience: resourceUrl })`, using `requestState.toAuth()`, never from `auth({ acceptsToken: 'oauth_token' })` alone, a cached result, or a hand-built one. Otherwise use the built-in Clerk path, `clerkInstrumentHandler(handler, { clerkClient, resourceUrl })`. Catch the errors your JWT library throws for a token it rejects, such as `JWTExpired` from `jose` or `TokenExpiredError` from `jsonwebtoken`, and return `undefined` or throw an `McpTokenVerificationError`, so the token gets the `401` `invalid_token` challenge, which [RFC 6750 section 3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1) gives an expired or invalid token, and the client can get a new one. Any other error the function throws means the token could not be verified at all: the middleware throws an `McpAuthError` to Hono's error handler, whose default answer is the JSON `{"error":"server_error"}`, with a `500` unless the error has a `429` or `5xx` `status`, and the client keeps the token.

Version 0.9.0 took the verifier alone, as `mcpAuth(verifyToken)`. That form now throws a `Clerk error:` at startup; pass `mcpAuth({ verifyToken, ...options })` instead.

Unknown option keys, such as `requiredScope` instead of `requiredScopes`, throw a `Clerk error:` at setup rather than being ignored. Setting both `clerkClient` and `verifyToken` also throws: choose Clerk verification with `clerkClient` and `resourceUrl`, or your own `verifyToken`. `properties` belongs only to `protectedResourceMetadataHandler`. `onAuthFailure` is a Next.js-only option and is rejected here.

A token Clerk rejects gets a `401` challenge. If Clerk cannot verify an opaque token at all, for example during an outage, when Clerk rate-limits the server, or with an invalid secret key, the middleware throws to Hono's error handler, and Hono's default handler answers with a JSON `{"error":"server_error"}` and the `429` or `5xx` status Clerk's Backend API answered with, or `500`, and logs the error with `console.error`, so clients keep their tokens instead of restarting authorization. A Backend API `4xx` other than `401` and `429` means Clerk refused the token, so it gets the `401` challenge. A JWT access token gets that server error when Clerk's signing keys can't be loaded. With current `@clerk/backend` releases that is only when the request for the signing keys is answered with an error status and a JSON body: they report every other failure to load the signing keys, such as an invalid secret key, a network error, or an error page that is not JSON, as they report an invalid signature, so the client gets the `401` `invalid_token` challenge and authorizes again. Once clerk/javascript#10826 ships, `@clerk/backend` reports those failures as `jwk-remote-failed-to-load`, and each of them gets the server error.

A request the middleware answers itself, with a `401` or `403` challenge or a `421`, gets `c.get('mcpAuthFailure')`, whose `reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`, which a middleware mounted earlier can read after `await next()`, for example for logging. When `verifyToken` throws, or Clerk cannot verify the token, the middleware throws an `McpAuthError` to Hono's error handler instead, with `reason: 'verification_failed'` and the thrown error as its `cause`. A custom `onError` replaces the default answer and logging, so answer with the same JSON and status there, and keep the default handler's answer for other errors: the `getResponse()` of an error that has one, such as an `HTTPException`, and otherwise a logged `500`. Under Clerk verification, what Clerk reported is an `McpTokenVerificationError`, whose `code` is Clerk's reason, such as `token-verification-failed`, and whose `message` is Clerk's message, which says which check failed. It is the `cause` of an `invalid_token` failure for a token Clerk rejected, and the `cause` of the `McpAuthError` when Clerk answered but could not verify the token. Your own `verifyToken` can throw one to reject a token with a code. It is never sent to the client:

```ts
import { McpAuthError } from '@clerk/mcp-tools/hono';

app.onError((err, c) => {
  if (err instanceof McpAuthError) {
    console.error('MCP auth failed', err.reason, err.cause);
    return Response.json({ error: 'server_error' }, { status: err.status ?? 500 });
  }
  // What Hono's default handler does for every other error
  if ('getResponse' in err) return err.getResponse();
  console.error(err);
  return c.text('Internal Server Error', 500);
});
```

Your Clerk instance must issue the `aud` claim. Clerk turns it on when you add your first MCP server to the instance in the Clerk Dashboard. The client must send `resource` matching `resourceUrl` when requesting a token. The first Clerk audience rejection (missing, invalid, or mismatched `aud`) logs a `Clerk warning:` once per auth middleware instance, explaining the Dashboard setup, `resource`, and backend minimum without logging the token or its claims. See [Build an MCP server](https://clerk.com/docs/guides/ai/mcp/build-mcp-server). Require `@clerk/backend` 3.19.0 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

### Public access

A server is discoverable by default, so a client can connect and list without a token, and `publicAccess` lets it call the tools you list as well. It signs in only when it reaches something protected.

```ts
app.all(
  '/mcp',
  clerkInstrumentHandler(createMcpHandler(createServer), {
    resourceUrl: 'https://mcp.example.com/mcp',
    publicAccess: { tools: ['search_docs'] },
  }),
);
```

`c.get('mcpAuth')` is `undefined` for a request that `discoverable` or `publicAccess` let through, and its type is `AuthInfo | undefined`. `clerkInstrumentHandler` reads the body of a request without a token to check it, so a middleware before it that reads the body must use `c.req.json()` or `c.req.text()`, or read a copy, as `c.req.raw.clone().json()`. One that reads `c.req.raw` itself leaves `clerkInstrumentHandler` nothing to check, so a request without a token gets the `401` challenge, and `clerkInstrumentHandler` logs a one-time `Clerk warning:` naming the fix. See [Public access](../README.md#public-access-sign-in-only-when-needed) in the main guide for every rule.

### Per-tool scopes

Step-up authorization, a `403` challenge that makes the MCP client ask the user to approve more scopes before a tool runs, comes from the `scopeChallenge` option of `registerTool` with `requireAdditionalScopes`, and needs `@modelcontextprotocol/server` 2.3.0 or later. Build the server with SDK 2 and serve it with `createMcpHandler`, which sends that challenge:

```ts
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  clerkInstrumentHandler,
  clerkInstrumentServer,
  requireAdditionalScopes,
} from '@clerk/mcp-tools/hono';

function createServer() {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });
  clerkInstrumentServer(server);
  server.registerTool(
    'list_projects',
    {
      description: 'Lists the projects of the signed-in user',
      inputSchema: {},
      scopeChallenge: requireAdditionalScopes('projects:read'),
    },
    async () => {
      // ...
    },
  );
  return server;
}

app.all('/mcp', clerkInstrumentHandler(createMcpHandler(createServer), mcpAuthOptions));
```

`@modelcontextprotocol/sdk` 1.x has no `scopeChallenge` option, so on SDK 1 a tool must check its scopes itself. List the scope in `challengeScopes` so clients request it when they first authorize, and answer a token without it with an error result:

```ts
server.registerTool(
  'list_projects',
  { description: 'Lists the projects of the signed-in user', inputSchema: {} },
  async (_args, { authInfo }) => {
    if (!authInfo?.scopes.includes('projects:read')) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'This tool needs the projects:read scope. Ask the user to reconnect the MCP server and approve it.',
          },
        ],
      };
    }
    // ...
  },
);
```

See [Step-up for your own tools](../README.md#step-up-for-your-own-tools) in the main guide.

### Reporting tool calls

With `reportToolCalls`, Clerk records each tool call your MCP server answers: the tool, whether it succeeded, how long it took, and who called it. The calls show up in your instance's MCP analytics and audit log. Tool arguments and results are never sent.

It takes both calls from the [Quick Start](#with-clerk-authentication):

- `clerkInstrumentHandler(handler, { ...options, reportToolCalls: true })` on the route knows who made each request.
- `clerkInstrumentServer(server)` where each MCP server is created sees each tool call. It replaces `connect` on that server object only, and changes nothing a client sees.

A POST whose server was never passed to `clerkInstrumentServer` logs a one-time `Clerk warning:`, and so does an instrumented server answering a call that the deprecated `mcpAuth` authenticated.

Each report has:

- The tool's name, the server's name, whether the call succeeded, how long it took, and when it was made. A failed call also has its error code: the `_meta['clerk.com/error_code']` of an error result, as the prebuilt tools set it, or `jsonrpc:<code>` for a JSON-RPC error.
- The Clerk user ID, OAuth client ID, and access token ID, for a token Clerk verified. A token `verifyToken` verified sends none of them.
- The client's IP address: `cf-connecting-ip` on Cloudflare Workers, and the socket's address under `@hono/node-server`. Elsewhere, such as on Bun or behind a proxy on Node.js, pass an `ipAddress` function.
- The client's `User-Agent`, up to 512 characters.

Pass an options object instead of `true` to turn fields off, or to choose which tools are reported:

```ts
const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  reportToolCalls: {
    ipAddress: (c) => c.req.header('x-real-ip'),
    userAgent: false,
    identity: false,
    tools: (toolName) => toolName !== 'healthcheck',
    serverName: 'acme-production',
  },
} satisfies McpAuthOptions;
```

- `ipAddress` - `true`, the default, sends the address where the runtime reports it, as above. `false` sends none, and a function `(c) => string | undefined` returns it yourself, from a header your proxy sets. A value that isn't an IP address is not sent.
- `userAgent` and `identity` - `false` leaves out the `User-Agent`, or the user, OAuth client, and access token IDs. Both default to `true`.
- `tools` - `(toolName) => boolean`. A call to a tool it returns `false` for is not reported.
- `serverName` - The server name to report. Defaults to the name the server was created with.
- `secretKey` - The secret key of the instance the reports belong to. Defaults to `CLERK_SECRET_KEY` in the app's environment.
- `apiUrl` - The Backend API origin. Defaults to `CLERK_API_URL`, then `https://api.clerk.com`.
- `fetch` - Sends the reports. Defaults to the global `fetch`.

Unknown keys and invalid values throw a `Clerk error:` when the handler is created. Reports go to the Backend API's `POST /v1/mcp_tool_calls` in batches of up to 100. On Cloudflare Workers, a request's reports are sent with `waitUntil` once its response is over; elsewhere they are sent about a second after a call, as soon as 100 are waiting, and before the process exits. Sending them never delays or fails an MCP request: a batch the Backend API refuses, or that can't reach it, is dropped with a one-time `Clerk warning:`. A call without a token, which `publicAccess` lets through, is not reported.

### `protectedResourceMetadataHandler(options?)`

Handler that returns OAuth 2.0 Protected Resource Metadata (RFC 9728) for the Clerk instance in `CLERK_PUBLISHABLE_KEY`. A value that isn't a Clerk publishable key throws a `Clerk error:` naming the variable. For another authorization server, return `generateProtectedResourceMetadata` from `@clerk/mcp-tools/hono` in your own route. It takes the options you pass to `clerkInstrumentHandler`, all optional, plus `properties`, so the auth options can be reused here. Add `properties` only when calling the metadata handler, not the auth entry point. The handler ignores `clerkClient`, `verifyToken`, and `reportToolCalls`.

- `resourceUrl` (optional): the same value you pass to `clerkInstrumentHandler`, one URL or a list with one for each origin. The metadata's `resource` is then the URL `clerkInstrumentHandler` checks for the same request, and with a list a request to an origin none of them has gets a `421 Misdirected Request`. Without it, `resource` comes from the URL the metadata route was requested at, which can differ from the public URL behind a proxy, and MCP clients reject metadata whose `resource` differs from the URL they connect to.
- `requiredScopes` and `challengeScopes` (optional): the same values you pass to `clerkInstrumentHandler`. The metadata lists `requiredScopes` then `challengeScopes`, each once, as `scopes_supported`, and leaves `scopes_supported` out when there are none.
- `properties` (optional): additional metadata, such as `resource_name`. It overrides the generated metadata, except `resource`, which it can't set: pass the URL as `resourceUrl`, so `resource` is the URL `clerkInstrumentHandler` checks (RFC 9728 section 3.3). Setting it throws a `Clerk error:` when the handler is created. A `scopes_supported` here is used as given, to list more scopes than the server asks for, but it must include every `requiredScopes` and `challengeScopes` entry, or the handler throws a `Clerk error:` naming the missing ones when it is created.

### `authorizationServerMetadataHandler()`

Handler that fetches and returns Clerk's OAuth Authorization Server Metadata. Requires `CLERK_PUBLISHABLE_KEY`. A value that isn't a Clerk publishable key throws a `Clerk error:` naming the variable.

Both metadata handlers send the same headers as the Next.js ones: `Cache-Control: max-age=3600` and the CORS headers in `metadataCorsHeaders`, which allow any origin, on the metadata, and the CORS headers alone, with no caching, on an error such as the `421` or `502`. Mounted for `OPTIONS` as well as `GET` (`app.on(['GET', 'OPTIONS'], path, handler)` or `app.all`), each answers the CORS preflight with a `200` and those CORS headers. A `cors()` middleware in front of them, as in the Quick Start, answers the preflight itself, and on the `GET` the headers it sets, such as its `Access-Control-Allow-Origin`, are kept in place of the handlers' own.

### `serverCardHandler(options)`

Handler that serves an MCP [Server Card](../README.md#discovery-server-cards). It takes the `generateServerCard` options, with `resourceUrl` as one URL or a list with one for each origin, plus `maxAge`, the seconds the card may be reused before revalidation (default `3600`; `0` for `public, no-cache`). It validates them and generates the card when it is created, throwing a `Clerk error:` for anything the card can't have, so it needs no Clerk keys or MCP SDK, and later changes to the options change nothing. Mount it with `app.all` so `OPTIONS` and other methods reach it:

```ts
import { serverCardHandler } from '@clerk/mcp-tools/hono';

app.all(
  '/mcp/server-card',
  serverCardHandler({
    name: 'com.example/weather',
    version: '1.2.0',
    description: 'Forecasts and current conditions.',
    resourceUrl: 'https://mcp.example.com/mcp',
  }),
);
```

`GET` and `HEAD` get the card with a weak `ETag` and public caching, a matching `If-None-Match` gets a bodyless `304`, `OPTIONS` the CORS preflight, other methods a `405`, and a request to an origin no listed `resourceUrl` has a `421`. Every error is sent with `Cache-Control: no-store`, so no cache keeps it. The handler sends its own `ETag`, `Cache-Control`, and `Content-Length` over earlier values and keeps other headers that earlier middleware set; as with the metadata handlers, for an origin a `cors()` middleware in front of it allows, that middleware's `Access-Control-Allow-Origin` replaces the handler's `*`. Mount discovery routes outside a restrictive `cors()` to keep them readable from any origin.

### `aiCatalogHandler(options)`

Handler that serves an [AI Catalog](../README.md#discovery-ai-catalogs) linking to MCP Server Cards. It takes the `generateAICatalog` options plus `maxAge`, as `serverCardHandler` does. It validates them and generates the catalog when it is created, throwing a `Clerk error:` for anything the catalog can't have, so it needs no Clerk keys or MCP SDK, never fetches the cards it links to, and later changes to the options change nothing. Mount the one handler with `app.all` at both [catalog paths](../README.md#discovery-ai-catalogs), `/.well-known/ard.json` and `/.well-known/ai-catalog.json`:

```ts
import { aiCatalogHandler } from '@clerk/mcp-tools/hono';

const catalog = aiCatalogHandler({
  entries: [
    {
      identifier: 'urn:air:example.com:weather',
      displayName: 'Weather',
      url: 'https://mcp.example.com/mcp/server-card',
    },
  ],
});

app.all('/.well-known/ard.json', catalog);
app.all('/.well-known/ai-catalog.json', catalog);
```

It answers as `serverCardHandler` does, with `application/ai-catalog+json`, and treats earlier middleware headers the same way: its own `ETag`, `Cache-Control`, and `Content-Length` win, other earlier headers are kept, and a `cors()` middleware's `Access-Control-Allow-Origin` still wins. Both paths get the same body and headers. The catalog is the same for every request, so it never answers `421`; for several origins, create one handler for each, pick it by `new URL(c.req.url).origin`, and answer `421` for an origin without one rather than serving another origin's catalog.

### `streamableHttpHandler(createServer, Transport)`

**Deprecated.** Use [`clerkInstrumentHandler`](#clerkinstrumenthandlerhandler-options) with the handler `createMcpHandler` from `@modelcontextprotocol/server` returns. `streamableHttpHandler` doesn't report tool calls.

Handler that creates an `McpServer` and a transport for each request. Pass `WebStandardStreamableHTTPServerTransport` as `Transport`, from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` on SDK 1.x or from `@modelcontextprotocol/server` on SDK 2.x, with `McpServer` from the same SDK: this package takes the class instead of importing the SDK, so apps that don't serve MCP with this handler never need the SDK, and the types are inferred from the class. Passes any auth info set by `mcpAuth` through to the MCP server. The factory must return a new server instance on every call so concurrent and abandoned requests remain isolated. The server is stateless, so it has no session for a `GET` to stream on or a `DELETE` to end. Any request that isn't a `POST` gets a `405` with `Allow: POST` and a JSON-RPC `Method not allowed.` error, the same answer MCP SDK 2 gives. Mount it with `app.all('/mcp', ...)` behind `mcpAuth`, so a `GET` without a token reaches `mcpAuth` and gets the `401` or, with [public access](#public-access), the `405`, rather than a Hono `404`.
