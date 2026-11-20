# MCP Tools - Hono Integration

Hono utilities for building MCP servers with authentication support.

## Installation

```bash
npm install @clerk/mcp-tools hono @clerk/backend @modelcontextprotocol/sdk
# On Node.js, to start the server
npm install @hono/node-server
```

These are optional peer dependencies, so the package manager doesn't install them for you or warn when one is missing. The package is ESM-only: it has no CommonJS build, so import it from an ES module (`"type": "module"` in `package.json`).

The MCP SDK is only for `streamableHttpHandler`, which runs your server on the SDK's web-standard transport. It takes either `@modelcontextprotocol/sdk` 1.x or `@modelcontextprotocol/server` 2.x, whichever your server is built with. On SDK 2.1 or later, its `scopeChallenge` step-up works through the handler too; see [Per-tool scopes](#per-tool-scopes). An app that uses only the auth middleware and metadata handlers, for example with MCP SDK 2's `@modelcontextprotocol/hono`, does not need the handler.

The tools in `@clerk/mcp-tools/tools`, such as `submitFeedbackTool`, also import `zod` (3.25 or later, or 4), an optional peer dependency. Add it to your app's own dependencies, on the same major version your MCP SDK uses (4.2 or later for SDK 2), even though the SDK depends on it too: a package manager that doesn't hoist dependencies, such as Yarn PnP or pnpm with an isolated layout, can't resolve the SDK's copy from `@clerk/mcp-tools`.

`mcpAuth` builds its Clerk client with `createClerkClient` from `@clerk/backend`, from the `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` environment variables, and `CLERK_API_URL`, `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set. It loads the package only when it builds that client, so an app that passes `clerkClient` or `verifyToken` doesn't need it.

## Quick Start

### With Clerk Authentication

```ts
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { cors } from 'hono/cors';
import {
  type McpAuthOptions,
  isClerkAuthInfo,
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
  streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
);

export default app;
```

`export default app` is the form Cloudflare Workers and Bun run. On Node.js, install `@hono/node-server` and start the server instead:

```ts
import { serve } from '@hono/node-server';

serve({ fetch: app.fetch, port: 3000 });
```

To let clients connect, list tools, and call some of them before the user signs in, add `publicAccess` to the shared options. A tool you don't list still gets the `401` challenge. See [Public access](#public-access).

```ts
const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
  publicAccess: { methods: true, tools: ['search_docs'] },
} satisfies McpAuthOptions;
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
  streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
);

export default app;
```

## Reference

### `mcpAuth(options)`

Middleware that enforces authentication for MCP requests. Extracts the bearer token from the `Authorization` header, verifies it with Clerk, including that its audience is `resourceUrl`, or with your `verifyToken` function, and stores the result in Hono context for downstream handlers (`c.get('mcpAuth')`). Returns `401` with a `WWW-Authenticate` header if the token is missing, malformed, or rejected, adding `error="invalid_token"` for a rejected token. A malformed `Bearer` credential, such as `Bearer a b`, and more than one `Authorization` header get that `401` challenge, not the `400` `invalid_request` that [RFC 6750 section 3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1) recommends for a malformed request, so the client can still start authorization; they are the only departure from that section. Another scheme, such as `Basic`, gets the challenge without an error code, as that section says for an unsupported authentication method.

- `resourceUrl`: the exact URL clients use for this endpoint, or a list of them, one for each origin, for a server that answers on several hostnames. Required unless you pass `verifyToken`. With a list, a request uses the URL with its origin, and a request to any other origin gets a `421 Misdirected Request` without a challenge, with `c.get('mcpAuthFailure')` set to `misdirected_request`. Under Clerk verification that URL is the audience, so a token issued for one listed URL doesn't pass on another. For a list, pick the metadata route's `resource` with `matchResourceUrl` from `@clerk/mcp-tools/hono`. The challenge's `resource_metadata` is derived from it. A single URL is used whatever origin the request has, so it works behind a proxy as it is. Only a list is matched against the request's origin, which comes from `c.req.url`: behind a proxy that terminates TLS or rewrites `Host`, as with Node.js behind nginx, that is the origin the app sees, not the public one, and every request gets a `421`. Rebuild the request URL from `X-Forwarded-*` headers you trust before this middleware. Never list the internal URLs: each listed URL is an audience and a metadata `resource`, and clients connect to the public one. With `verifyToken` and without `resourceUrl`, the URL comes from the request, which can differ from the public URL behind a proxy. Pass the same value to the metadata route, as in `protectedResourceMetadataHandler({ resourceUrl })`, so its `resource` is the URL checked here, or build the route with `generateProtectedResourceMetadata` from `@clerk/mcp-tools/hono`, passing the same URL as its `resourceUrl`.
- `requiredScopes`: scopes every request needs. A token without them gets a `403` with `error="insufficient_scope"` and a `scope` that lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry, so the new grant keeps the old access. The `401` challenge lists them in its `scope`. The `403` asks for those scopes by name, so enable each `requiredScopes` and `challengeScopes` entry for the OAuth application in Clerk: a scope it can't be granted is missing from the new token too, and the client gets the `403` again.
- `challengeScopes`: more scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them. When a token lacks a `requiredScopes` entry, the `403` lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry. List each tool's `requireAdditionalScopes` scopes here to have the client reauthorize once instead of twice. A token that lacks only `challengeScopes` entries is let through.
- `publicAccess` (optional): what a request without a token may do: `methods` (`true`, or a list of protocol methods), `tools` (tool names), and `resources` and `prompts` (`true`, or a list of resource URIs or prompt names). Without it, every such request gets the `401`. See [Public access](#public-access).
- `clerkClient` (optional): the Clerk client that verifies tokens, or a function that returns one (or a promise of one), which is called once per request. A value without `authenticateRequest` throws a `Clerk error:` when `mcpAuth` is called. Without it, `mcpAuth` builds one with `createClerkClient` from `@clerk/backend`, from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` read through Hono's `env(c)`, so it works on Cloudflare Workers, where they are only on `c.env`. It also passes `CLERK_API_URL`, `CLERK_API_VERSION`, and `CLERK_JWT_KEY` when they are set, as `clerkClient` from `@clerk/express` does. It keeps that client for later requests with the same settings. A missing variable throws a `Clerk error:` that names it, and a missing `@clerk/backend` throws a `Clerk error:` asking you to install it or pass `clerkClient`. `clerkMiddleware()` also verifies the token, so keep it off the MCP route, or each token is verified twice. A client you pass must come from `@clerk/backend` 3.19.0 or later, the first with a reliable audience check. Not allowed together with `verifyToken`.
- `verifyToken` (optional): `(token: string, c: Context) => AuthInfo | undefined | Promise<AuthInfo | undefined>`, a function that verifies the token in place of Clerk and returns the auth data, or `undefined` to reject it. The result must have a finite `expiresAt`, in seconds since the epoch, and a non-empty `clientId`, or the token gets the `401` `invalid_token` challenge, with an `McpTokenVerificationError` cause whose `code` is `token-claims-missing` and whose `message` names the missing field. [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-handling), 2025-06-18 and later, has servers validate tokens as [OAuth 2.1 section 5.2](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5.2) describes, which includes checking that the token is not expired, and [RFC 9068 section 2.2](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2) makes `exp` and `client_id` REQUIRED in a JWT access token. JWT libraries such as `jsonwebtoken` and `jose` check `exp` only when the token has one, so pass it through as `expiresAt`. Auth info from `toClerkAuthInfo` is treated as Clerk-verified, so it passes without an `expiresAt` or a `clientId`, since Clerk checks those itself: build it only from a request state returned by `authenticateRequest(req, { acceptsToken: 'oauth_token', audience: resourceUrl })`, using `requestState.toAuth()`, never from `auth({ acceptsToken: 'oauth_token' })` alone, a cached result, or a hand-built one. Otherwise use the built-in Clerk path, `mcpAuth({ clerkClient, resourceUrl })` (or `withClerkMcpAuth(handler, { clerkClient, resourceUrl })` in Next.js). Catch the errors your JWT library throws for a token it rejects, such as `JWTExpired` from `jose` or `TokenExpiredError` from `jsonwebtoken`, and return `undefined` or throw an `McpTokenVerificationError`, so the token gets the `401` `invalid_token` challenge, which [RFC 6750 section 3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1) gives an expired or invalid token, and the client can get a new one. Any other error the function throws means the token could not be verified at all: the middleware throws an `McpAuthError` to Hono's error handler, whose default answer is the JSON `{"error":"server_error"}`, with a `500` unless the error has a `429` or `5xx` `status`, and the client keeps the token.

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

### Per-tool scopes

Step-up authorization, a `403` challenge that makes the MCP client ask the user to approve more scopes before a tool runs, comes from the `scopeChallenge` option of `registerTool` with `requireAdditionalScopes`, and needs `@modelcontextprotocol/server` 2.1 or later. Build the server with SDK 2 and pass its transport to `streamableHttpHandler`, and the handler sends that challenge:

```ts
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { requireAdditionalScopes, streamableHttpHandler } from '@clerk/mcp-tools/hono';

function createServer() {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });
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

app.all(
  '/mcp',
  mcpAuth(mcpAuthOptions),
  streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport),
);
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

### `protectedResourceMetadataHandler(options?)`

Handler that returns OAuth 2.0 Protected Resource Metadata (RFC 9728) for the Clerk instance in `CLERK_PUBLISHABLE_KEY`. A value that isn't a Clerk publishable key throws a `Clerk error:` naming the variable. For another authorization server, return `generateProtectedResourceMetadata` from `@clerk/mcp-tools/hono` in your own route. It takes the options you pass to `mcpAuth`, all optional, plus `properties`, so the auth options can be reused here. Add `properties` only when calling the metadata handler, not the auth entry point. The handler ignores `clerkClient` and `verifyToken`.

- `resourceUrl` (optional): the same value you pass to `mcpAuth`, one URL or a list with one for each origin. The metadata's `resource` is then the URL `mcpAuth` checks for the same request, and with a list a request to an origin none of them has gets a `421 Misdirected Request`. Without it, `resource` comes from the URL the metadata route was requested at, which can differ from the public URL behind a proxy, and MCP clients reject metadata whose `resource` differs from the URL they connect to.
- `requiredScopes` and `challengeScopes` (optional): the same values you pass to `mcpAuth`. The metadata lists `requiredScopes` then `challengeScopes`, each once, as `scopes_supported`, and leaves `scopes_supported` out when there are none.
- `properties` (optional): additional metadata, such as `resource_name`. It overrides the generated metadata, except `resource`, which it can't set: pass the URL as `resourceUrl`, so `resource` is the URL `mcpAuth` checks (RFC 9728 section 3.3). Setting it throws a `Clerk error:` when the handler is created. A `scopes_supported` here is used as given, to list more scopes than the server asks for, but it must include every `requiredScopes` and `challengeScopes` entry, or the handler throws a `Clerk error:` naming the missing ones when it is created.

### `authorizationServerMetadataHandler()`

Handler that fetches and returns Clerk's OAuth Authorization Server Metadata. Requires `CLERK_PUBLISHABLE_KEY`. A value that isn't a Clerk publishable key throws a `Clerk error:` naming the variable.

Both metadata handlers send the same headers as the Next.js ones: `Cache-Control: max-age=3600` and the CORS headers in `metadataCorsHeaders`, which allow any origin, on the metadata, and the CORS headers alone, with no caching, on an error such as the `421` or `502`. Mounted for `OPTIONS` as well as `GET` (`app.on(['GET', 'OPTIONS'], path, handler)` or `app.all`), each answers the CORS preflight with a `200` and those CORS headers. A `cors()` middleware in front of them, as in the Quick Start, answers the preflight itself, and on the `GET` the headers it sets, such as its `Access-Control-Allow-Origin`, are kept in place of the handlers' own.

### `serverCardHandler(options)`

Handler that serves an MCP [Server Card](../README.md#discovery-server-cards-beta) (beta). It takes the `generateServerCard` options, with `resourceUrl` as one URL or a list with one for each origin, plus `maxAge`, the seconds the card may be reused before revalidation (default `3600`; `0` for `public, no-cache`). It validates them and generates the card when it is created, throwing a `Clerk error:` for anything the card can't have, so it needs no Clerk keys or MCP SDK, and later changes to the options change nothing. Mount it with `app.all` so `OPTIONS` and other methods reach it:

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

`GET` and `HEAD` get the card with a weak `ETag` and public caching, a matching `If-None-Match` gets a bodyless `304`, `OPTIONS` the CORS preflight, other methods a `405`, and a request to an origin no listed `resourceUrl` has a `421`. Every error is sent with `Cache-Control: no-store`, so no cache keeps it. Headers that earlier middleware set are kept, and as with the metadata handlers, for an origin a `cors()` middleware in front of it allows, that middleware's `Access-Control-Allow-Origin` replaces the handler's `*`. Mount discovery routes outside a restrictive `cors()` to keep them readable from any origin.

### `aiCatalogHandler(options)`

Handler that serves an [AI Catalog](../README.md#discovery-ai-catalogs-beta) (beta) linking to MCP Server Cards. It takes the `generateAICatalog` options plus `maxAge`, as `serverCardHandler` does. It validates them and generates the catalog when it is created, throwing a `Clerk error:` for anything the catalog can't have, so it needs no Clerk keys or MCP SDK, never fetches the cards it links to, and later changes to the options change nothing. Mount it with `app.all`:

```ts
import { aiCatalogHandler } from '@clerk/mcp-tools/hono';

app.all(
  '/.well-known/ai-catalog.json',
  aiCatalogHandler({
    entries: [
      {
        identifier: 'urn:air:example.com:weather:mcp',
        displayName: 'Weather',
        url: 'https://mcp.example.com/mcp/server-card',
      },
    ],
  }),
);
```

It answers as `serverCardHandler` does, with `application/ai-catalog+json`, and keeps earlier middleware headers the same way. The catalog is the same for every request, so it never answers `421`; for several origins, create one handler for each, pick it by `new URL(c.req.url).origin`, and answer `421` for an origin without one rather than serving another origin's catalog.

### `streamableHttpHandler(createServer, Transport)`

Handler that creates an `McpServer` and a transport for each request. Pass `WebStandardStreamableHTTPServerTransport` as `Transport`, from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` on SDK 1.x or from `@modelcontextprotocol/server` on SDK 2.x, with `McpServer` from the same SDK: this package takes the class instead of importing the SDK, so apps that don't serve MCP with this handler never need the SDK, and the types are inferred from the class. Passes any auth info set by `mcpAuth` through to the MCP server. The factory must return a new server instance on every call so concurrent and abandoned requests remain isolated. The server is stateless, so it has no session for a `GET` to stream on or a `DELETE` to end. Any request that isn't a `POST` gets a `405` with `Allow: POST` and a JSON-RPC `Method not allowed.` error, the same answer MCP SDK 2 gives. Mount it with `app.all('/mcp', ...)` behind `mcpAuth`, so a `GET` without a token reaches `mcpAuth` and gets the `401` or, with [public access](#public-access), the `405`, rather than a Hono `404`.
