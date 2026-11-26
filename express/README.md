# MCP Tools - Express.js Integration

Express.js utilities for building MCP servers with authentication support. These tools make it easy to add MCP (Model Context Protocol) endpoints to your existing Express applications.

## Installation

```bash
npm install @clerk/mcp-tools @clerk/express express@5 @modelcontextprotocol/server @modelcontextprotocol/node
```

This package supports `express` 5, `@clerk/express` 2.1.70 or later, `@modelcontextprotocol/server` 2.3.0 or later, and `@modelcontextprotocol/node` 2.1.2 or later. The prebuilt tools in `@clerk/mcp-tools/tools` also need `zod` 3.25 or later, or 4: `npm install zod`.

`@modelcontextprotocol/node` is only for serving the handler that `createMcpHandler` from `@modelcontextprotocol/server` returns, which `clerkInstrumentHandler` runs through its `toNodeHandler`. An app on MCP SDK 1.x (`@modelcontextprotocol/sdk` 1.32.0 or later) passes an Express handler of its own instead, as in [MCP SDK 1.x](#mcp-sdk-1x), and doesn't need it. `@clerk/express` is only for verifying tokens with Clerk's default client, so an app that passes `verifyToken` or its own `clerkClient` doesn't need it.

The MCP route does not need `clerkMiddleware()` from `@clerk/express`. `clerkInstrumentHandler` verifies the token itself, so adding `clerkMiddleware()` in front of it only adds a second, unused authentication pass to every request.

## Quick Start

### Example with Clerk Authentication

An MCP server takes two calls from this package: `clerkInstrumentHandler` on the route, which authenticates each request, and `clerkInstrumentServer` where the server is created, which lets Clerk [report its MCP activity](#reporting-mcp-activity).

```ts
import 'dotenv/config';
import express from 'express';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  type McpAuthOptions,
  authorizationServerMetadataHandler,
  clerkInstrumentHandler,
  clerkInstrumentServer,
  isClerkAuthInfo,
  protectedResourceMetadataHandler,
} from '@clerk/mcp-tools/express';

// One object for both calls, so the metadata lists the scopes `clerkInstrumentHandler` requires as `scopes_supported`
const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  requiredScopes: ['profile', 'email'],
  reporting: true,
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

const app = express();
app.use(express.json());

// `all`, not `get`, so the handlers also answer a browser-based client's CORS preflight
app.all(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceMetadataHandler(mcpAuthOptions),
);
app.all('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
app.all('/mcp', clerkInstrumentHandler(createMcpHandler(createServer), mcpAuthOptions));

app.listen(3000);
```

### MCP SDK 1.x

On `@modelcontextprotocol/sdk` 1.x, pass an Express handler that serves the SDK's transport. `clerkInstrumentHandler` sets `req.auth`, where the transport reads the auth info:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

app.all(
  '/mcp',
  clerkInstrumentHandler(async (req, res) => {
    const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
    clerkInstrumentServer(server);
    // Register your tools, resources, and prompts
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }, mcpAuthOptions),
);
```

### Example with Custom Authentication

Here's an example using custom JWT authentication:

```ts
import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import { type AuthInfo, McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  clerkInstrumentHandler,
  generateProtectedResourceMetadata,
} from '@clerk/mcp-tools/express';

const app = express();
app.use(express.json());
const resourceUrl = 'https://mcp.example.com/mcp';

// Custom token verification
// Return `undefined` to reject the token
async function verifyToken(token: string): Promise<AuthInfo | undefined> {
  try {
    // Check the audience: MCP servers must only accept tokens issued for them (MCP authorization spec, 2025-06-18 and later)
    const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
      audience: resourceUrl,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    return {
      token,
      clientId: decoded.client_id ?? decoded.azp,
      scopes: typeof decoded.scope === 'string' ? decoded.scope.split(' ') : [],
      expiresAt: decoded.exp,
      extra: { userId: decoded.sub },
    };
  } catch {
    return undefined;
  }
}

function createServer() {
  const server = new McpServer({ name: 'custom-auth-server', version: '1.0.0' });

  // The auth info is what `verifyToken` returned, so the user ID is the token's `sub`
  server.registerTool(
    'whoami',
    { description: 'Returns the ID of the user that authorized this request' },
    async (ctx) => ({
      content: [{ type: 'text', text: String(ctx.http?.authInfo?.extra?.userId) }],
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
  clerkInstrumentHandler(createMcpHandler(createServer), { verifyToken, resourceUrl }),
);

app.listen(3000);
```

## Serving MCP Requests

### `clerkInstrumentHandler(handler, options)`

An Express handler that authenticates each MCP request, then serves it with `handler`: the handler `createMcpHandler` from `@modelcontextprotocol/server` returns, which it runs through `toNodeHandler` from `@modelcontextprotocol/node`, or an Express handler of your own. By default it verifies OAuth access tokens with Clerk, including that their audience is this endpoint. Pass `verifyToken` to verify tokens with your own function instead. Mount it with `app.all`, after `express.json()`.

`mcpAuth(options)`, the middleware it replaces, is deprecated. It takes the same options except `reporting`, which it refuses with a `Clerk error:`, since it never sees a tool call.

**Options:**

- `resourceUrl` - The exact URL clients use for this endpoint, or a list of them, one for each origin, for a server that answers on several hostnames. Required unless you pass `verifyToken`. With a list, a request uses the URL with its origin, and a request to any other origin gets a `421 Misdirected Request` without a challenge. Under Clerk verification that URL is the audience: Clerk rejects a token whose `aud` claim does not include the URL for the request's origin, so a token issued for one listed URL doesn't pass on another. The request's origin comes from `req.protocol` and `req.host`, so behind a proxy set `trust proxy` to read them from `X-Forwarded-Proto` and `X-Forwarded-Host`. The challenge's `resource_metadata` is derived from it. With `verifyToken`, set `resourceUrl` for the verifier's reported `resource` to be checked, and pass the same value to the metadata route, as in `protectedResourceMetadataHandler({ resourceUrl })`. Without `resourceUrl`, a URL derived from the request is used only to locate metadata, can differ from the public URL behind a proxy, and is not checked against the verifier's reported `resource`. A route of your own, built with `generateProtectedResourceMetadata` from `@clerk/mcp-tools/express`, picks the URL for a list with `matchResourceUrl`.
- `requiredScopes` (optional) - Scopes every request needs. A token without them gets a `403` with `error="insufficient_scope"` and a `scope` that lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry. The `401` challenge lists them in its `scope`.
- `challengeScopes` (optional) - More scopes for the `401` challenge's `scope`, after `requiredScopes`, such as the scopes your tools step up to. MCP clients request the `401` challenge's `scope` when they first authorize. A token is not required to have them. When a token lacks a `requiredScopes` entry, the `403` lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry. List each tool's `requireAdditionalScopes` scopes here to have the client reauthorize once instead of twice. A token that lacks only `challengeScopes` entries is let through.
- `discoverable` (optional) - What a request without a token may list: `true`, the default, lets anyone connect and list the tools, resources, resource templates, and prompts; `false` requires a token for every MCP request. Protected resource metadata and the Server Card are public either way. See [Public access](#public-access).
- `publicAccess` (optional) - What else a request without a token may do: `tools` (tool names), and `resources` and `prompts` (`true`, or a list of resource URIs or prompt names), on top of what `discoverable` opens. See [Public access](#public-access).
- `clerkClient` (optional) - The Clerk client that verifies tokens. Defaults to `clerkClient` from `@clerk/express`, which reads `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` and is loaded on the first request, so an app that passes `verifyToken` or its own client doesn't need `@clerk/express` installed. `clerkInstrumentHandler` doesn't need `clerkMiddleware()` and doesn't read the auth it sets. When the keys don't come from those environment variables, pass a client created with them here, or a function that returns one (or a promise of one), which is called once per request. A value without `authenticateRequest` throws a `Clerk error:` when `clerkInstrumentHandler` is called. Create it with both `secretKey` and `publishableKey`. Without this option, a missing `CLERK_SECRET_KEY` or `CLERK_PUBLISHABLE_KEY` makes every request throw a `Clerk error:` naming it, as in the Hono adapter. A client from `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check. Not allowed together with `verifyToken`.
- `verifyToken` (optional) - `(token: string, req: express.Request) => AuthInfo | undefined | Promise<AuthInfo | undefined>`, a function that verifies the token in place of Clerk and returns the auth data, or `undefined` to reject it. The result must have a finite `expiresAt`, in seconds since the epoch, and a non-empty `clientId`, or the token gets the `401` `invalid_token` challenge, with an `McpTokenVerificationError` cause whose `code` is `token-claims-missing` and whose `message` names the missing field. [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-handling), 2025-06-18 and later, has servers validate tokens as [OAuth 2.1 section 5.2](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-5.2) describes, which includes checking that the token is not expired, and [RFC 9068 section 2.2](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2) makes `exp` and `client_id` REQUIRED in a JWT access token. JWT libraries such as `jsonwebtoken` and `jose` check `exp` only when the token has one, so pass it through as `expiresAt`. Auth info from `toClerkAuthInfo` is treated as Clerk-verified, so it passes without an `expiresAt` or a `clientId`, since Clerk checks those itself: build it only from a request state returned by `authenticateRequest(req, { acceptsToken: 'oauth_token', audience: resourceUrl })`, using `requestState.toAuth()`, never from `auth({ acceptsToken: 'oauth_token' })` alone, a cached result, or a hand-built one. Otherwise use the built-in Clerk path, `clerkInstrumentHandler(handler, { clerkClient, resourceUrl })`. Catch the errors your JWT library throws for a token it rejects, such as `JWTExpired` from `jose` or `TokenExpiredError` from `jsonwebtoken`, and return `undefined` or throw an `McpTokenVerificationError`, so the token gets the `401` `invalid_token` challenge, which [RFC 6750 section 3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1) gives an expired or invalid token, and the client can get a new one. Any other error the function throws means the token could not be verified at all: it gets the JSON `{"error":"server_error"}` answer, with a `500` unless the error has a `429` or `5xx` `status`, and the client keeps the token.
- `reporting` (optional) - `true`, or an options object, to report MCP activity to Clerk: tool calls, auth failures, and initialize, list, resource read and prompt get requests. Off by default. See [Reporting MCP activity](#reporting-mcp-activity).

**Example:**

```ts
import { createMcpHandler } from '@modelcontextprotocol/server';
import { clerkInstrumentHandler } from '@clerk/mcp-tools/express';

app.use(express.json());
app.all(
  '/mcp',
  clerkInstrumentHandler(createMcpHandler(createServer), {
    resourceUrl: 'https://mcp.example.com/mcp',
    requiredScopes: ['profile', 'email'],
  }),
);
```

**Example with your own verifier:**

```ts
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import { clerkInstrumentHandler } from '@clerk/mcp-tools/express';

async function verifyToken(token: string, req: express.Request): Promise<AuthInfo | undefined> {
  // Your custom token verification logic. It must check that the token's audience is this server's URL: MCP servers
  // must only accept tokens issued for them (MCP authorization spec, 2025-06-18 and later)
  const user = await verifyMyToken(token);
  if (!user) return undefined; // Return undefined for invalid tokens
  // Return the auth info: `scopes` is what `requiredScopes` is checked against
  return {
    token,
    clientId: user.clientId,
    scopes: user.scopes,
    expiresAt: user.expiresAt,
    extra: { userId: user.id },
  };
}

app.use(express.json());
app.all('/mcp', clerkInstrumentHandler(createMcpHandler(createServer), { verifyToken }));
```

Version 0.9.0 took the verifier alone, as `await mcpAuth(verifyToken)`. That form now throws a `Clerk error:` at startup; pass `mcpAuth({ verifyToken, ...options })` instead.

Unknown option keys, such as `requiredScope` instead of `requiredScopes`, throw a `Clerk error:` at setup rather than being ignored. Setting both `clerkClient` and `verifyToken` also throws: choose Clerk verification with `clerkClient` and `resourceUrl`, or your own `verifyToken`. `properties` belongs only to `protectedResourceMetadataHandler`. `onAuthFailure` is a Next.js-only option and is rejected here.

It will:

- Check for the `Authorization` header
- Extract the Bearer token
- Verify it with Clerk, or call your `verifyToken` function
- Return a 401 response with a `WWW-Authenticate` header if the token is missing, malformed, or rejected, or if the request has more than one `Authorization` header. A malformed `Bearer` credential, such as `Bearer a b`, and more than one `Authorization` header get that `401` challenge, not the `400` `invalid_request` that [RFC 6750 section 3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1) recommends for a malformed request, so the client can still start authorization; they are the only departure from that section. Another scheme, such as `Basic`, gets the challenge without an error code, as that section says for an unsupported authentication method.
- Return a 403 response with an `insufficient_scope` challenge if the token lacks `requiredScopes`
- Add the auth data to `req.auth` and pass the request to `handler` if successful

The 403 challenge's `scope` lists the token's granted scopes followed by the missing ones, so the new grant keeps the old access. It asks for those scopes by name, so enable each `requiredScopes` and `challengeScopes` entry for the OAuth application in Clerk: a scope it can't be granted is missing from the new token too, and the client gets the `403` again.

A token Clerk rejects gets a `401` challenge. If Clerk cannot verify an opaque token at all, for example during an outage, when Clerk rate-limits the server, or with an invalid secret key, the middleware answers with a JSON `{"error":"server_error"}` and the `429` or `5xx` status Clerk's Backend API answered with, or `500`, so clients keep their tokens instead of restarting authorization. It never sends Express's HTML error page, which shows the stack trace outside production. A Backend API `4xx` other than `401` and `429` means Clerk refused the token, so it gets the `401` challenge. A JWT access token gets that server error when Clerk's signing keys can't be loaded. With current `@clerk/backend` releases that is only when the request for the signing keys is answered with an error status and a JSON body: they report every other failure to load the signing keys, such as an invalid secret key, a network error, or an error page that is not JSON, as they report an invalid signature, so the client gets the `401` `invalid_token` challenge and authorizes again. Once clerk/javascript#10826 ships, `@clerk/backend` reports those failures as `jwk-remote-failed-to-load`, and each of them gets the server error.

A request the middleware answers itself, with a `401` or `403` challenge or a `421`, gets `res.locals.mcpAuthFailure`, whose `reason` is `missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`, for example for logging from a `res.on('finish')` listener. When `verifyToken` throws, or Clerk cannot verify the token, the middleware sends that JSON answer and logs an `McpAuthError` with `console.error`, with `reason: 'verification_failed'` and the thrown error as its `cause`. It does not pass the error to your error middleware: Express's default error handler would then close a connection whose request body is still uploading, and the client would get a reset instead of the answer. Under Clerk verification, what Clerk reported is an `McpTokenVerificationError`, whose `code` is Clerk's reason, such as `token-verification-failed`, and whose `message` is Clerk's message, which says which check failed. It is the `cause` of an `invalid_token` failure for a token Clerk rejected, and the `cause` of the `McpAuthError` when Clerk answered but could not verify the token. Your own `verifyToken` can throw one to reject a token with a code. It is never sent to the client.

Your Clerk instance must issue the `aud` claim. Clerk turns it on when you add your first MCP server to the instance in the Clerk Dashboard. The client must send `resource` matching `resourceUrl` when requesting a token. The first Clerk audience rejection (missing, invalid, or mismatched `aud`) logs a `Clerk warning:` once per auth middleware instance, explaining the Dashboard setup, `resource`, and backend minimum without logging the token or its claims. See [Build an MCP server](https://clerk.com/docs/guides/ai/mcp/build-mcp-server). Require `@clerk/express` 2.1.70 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

### Public access

A server is discoverable by default, so a client can connect and list without a token, and `publicAccess` lets it call the tools you list as well. It signs in only when it reaches something protected. `clerkInstrumentHandler` reads the body that `express.json()` parsed, so mount that middleware before `clerkInstrumentHandler`. Only a body sent as `application/json` can be public: a form that `express.urlencoded()` parsed gets the `401`, as it does in the Hono and Next.js adapters. Without it, nothing is open: a JSON request without a token gets the `401` challenge, and `clerkInstrumentHandler` logs a one-time `Clerk warning:` naming `express.json()`. A body with a `Content-Encoding` other than `identity`, such as `gzip`, gets the `401` without a token: the parsed JSON cannot establish its encoded byte count. A valid bearer token can still authenticate a compressed request. `express.json()` reads the whole body before `clerkInstrumentHandler` sees it, and its `limit` bounds decoded bytes, not compressed bytes received. Set `express.json({ limit })` to the decoded size you accept; its 100kb default is below the 1 MiB that `publicAccess` accepts. Use `inflate: false` or a separate upstream encoded-byte limit if you also need to bound compressed ingress before parsing. `clerkInstrumentHandler` still treats an identity body over 1 MiB as not public, but for a chunked body it measures the parsed body serialized again, which differs from the bytes sent by whitespace and number formatting, so that check is not an exact byte limit.

```ts
app.use(express.json());
app.all(
  '/mcp',
  clerkInstrumentHandler(createMcpHandler(createServer), {
    resourceUrl: 'https://mcp.example.com/mcp',
    publicAccess: { tools: ['search_docs'] },
  }),
);
```

`req.auth` is `undefined` for a request that `discoverable` or `publicAccess` let through. Set `discoverable: false` to require a token for every request, which also lets `clerkInstrumentHandler` run without `express.json()`: it cannot be set next to a `publicAccess.methods` list, so nothing is open and the body is never read. See [Public access](../README.md#public-access-sign-in-only-when-needed) in the main guide for every rule.

## Reporting MCP activity

With `reporting`, Clerk records each tool call your MCP server answers: the tool, whether it succeeded, how long it took, and who called it. The calls show up in your instance's MCP analytics and audit log. Tool arguments and results are never sent.

It takes both calls from the [Quick Start](#example-with-clerk-authentication):

- `clerkInstrumentHandler(handler, { ...options, reporting: true })` on the route knows who made each request.
- `clerkInstrumentServer(server)` where each MCP server is created sees each tool call and the other requests below. It replaces `connect` on that server object only, and changes nothing a client sees. Call it before registering tools, resources, and prompts: it also wraps `registerTool`, `registerResource`, and `registerPrompt`, and `tool`, `resource`, and `prompt` on MCP SDK 1.x, to time each handler, tell a throw from a returned error, and name each resource read by the resource it matched. Anything registered before it, or whose callback is replaced with `update({ callback })`, is reported without them.

A POST whose server was never passed to `clerkInstrumentServer` logs a one-time `Clerk warning:`, and so does an instrumented server answering a call that the deprecated `mcpAuth` authenticated.

Each report has:

- The tool's name, the server's name, whether the call succeeded, how long it took and how long its handler ran, and when it was made. A failed call also has its error code: the `_meta['clerk.com/error_code']` of an error result, as the prebuilt tools set it, `thrown:<ErrorClass>` for a handler that threw, with the error's class name and never its message, or `jsonrpc:<code>` for a JSON-RPC error. A call to a tool the `McpServer` does not have fails with `not_found`; a low-level `Server` keeps no list of its tools, so its calls keep the code of the response.
- Other requests, each as its own report: each `initialize`, with the client's name and version and the protocol version it asked for and got, or, on protocol revision 2026-07-28, which has no `initialize`, each `server/discover`, with the client and protocol version from its `_meta`; each `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`, and `tasks/list`, with its item count; each resource read, by the name of the registered resource it matched, and a template's URI template, or by the URI's scheme alone, and never by the URI asked for; and each prompt get, by the prompt's name, with its message count. Resource reads and prompt gets have the same outcome, error code, and times as tool calls, and one for a resource or prompt that isn't registered fails with `not_found`. Prompt arguments and resource contents are never sent. A client on 2026-07-28 that never sends `server/discover`, which the spec leaves optional for clients, is not reported as a connected client, though its other requests are.
- The Clerk user ID, OAuth client ID, access token ID, and organization ID, for a token Clerk verified. A token `verifyToken` verified sends none of them. A client that uses a [Client ID Metadata Document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-03#section-3) has an `https` URL as its client ID, which is sent as is when it has up to 512 printable ASCII characters, a host, and a path other than `/`, and no userinfo, fragment, or `.` or `..` path segment (including dots encoded as `%2e`, regardless of case). Any other client ID is sent when it has up to 128 letters, digits, `_`, `.`, `:`, `~`, or `-`.
- The request's MCP protocol version: the one its `_meta` names on protocol revision 2026-07-28, or the one the same server object negotiated in `initialize`. A server created for each request, as `createMcpHandler` does, never sees that `initialize`, so its reports on earlier revisions have none. An auth failure carries only a version its body's `_meta` names.
- A hash of the request's MCP session: the first 32 hex digits of the SHA-256 of `CLERK_PUBLISHABLE_KEY` and the `Mcp-Session-Id` header, so the reports of one session can be grouped. The session ID itself is never sent. A request without that header or key, or with a session ID longer than 256 characters, has none, and neither does an `initialize`, which comes before the session. Auth failures carry it too. No `reporting` option turns it off, not even `identity`.
- The client's IP address, from `req.ip`, which follows the app's `trust proxy` setting. Behind a proxy, set `trust proxy` for it to be the client's address.
- The client's `User-Agent`, up to 512 characters.

Pass an options object instead of `true` to turn fields off, or to choose which tools are reported:

```ts
const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  reporting: {
    ipAddress: false,
    userAgent: false,
    identity: false,
    tools: (toolName) => toolName !== 'healthcheck',
    serverName: 'acme-production',
  },
} satisfies McpAuthOptions;
```

- `ipAddress` - `true`, the default, sends `req.ip`. `false` sends none, and a function `(req) => string | undefined` returns the address yourself. A value that isn't an IP address is not sent.
- `userAgent` and `identity` - `false` leaves out the `User-Agent`, or the user, OAuth client, access token, and organization IDs. Both default to `true`.
- `tools` - `(toolName) => boolean`. A call to a tool it returns `false` for is not reported.
- `serverName` - The server name to report. Defaults to the name the server was created with.
- `secretKey` - The secret key of the instance the reports belong to. Defaults to `CLERK_SECRET_KEY`.
- `apiUrl` - The Backend API origin. Defaults to `CLERK_API_URL`, then `https://api.clerk.com`.
- `fetch` - Sends the reports. Defaults to the global `fetch`.

Unknown keys and invalid values throw a `Clerk error:` when the handler is created. Reports go to the Backend API's `POST /v1/mcp_events` in batches of up to 100: about a second after a call, as soon as 100 are waiting, and before the process exits. Sending them never delays or fails an MCP request: a batch the Backend API refuses, or that can't reach it, is dropped with a one-time `Clerk warning:`. At most 1,000 reports wait to be sent while the Backend API is slow to answer; past that the oldest are dropped, with a one-time `Clerk warning:`. A call without a token, which `publicAccess` lets through, is not reported.

With `reporting` on, `clerkInstrumentHandler` also reports each request it answers with a `401` or `403` challenge or a `421`, so you can see where agents get stuck before their first call. The report has the `reason` (`missing_token`, `malformed_token`, `invalid_token`, `insufficient_scope`, or `misdirected_request`), the HTTP status, the verifier's code for a rejected token, such as `token-invalid` (never its message), and the JSON-RPC method and tool name of the request's first message, read from a copy of a JSON body up to 64 KiB, so the request itself is untouched. The `serverName`, `ipAddress` and `userAgent` options apply to it as they do to tool calls, and a tool `tools` returns `false` for is reported without its name. Only a `403` carries the Clerk user, OAuth client, access token, and organization IDs, of the token Clerk verified that lacked the scopes; a `401` or `421` has none. The `400` to a request without a URL and the server error when a token could not be verified at all are not reported. The answer is sent first and the body read afterwards, so reporting never delays it. Since anyone can cause an auth failure, at most 100 a minute are reported for each secret key, and they wait apart from tool calls, so a burst of them never pushes a tool call out. A burst is gathered and sent in one batch about a second later.

## Protected Resource Metadata

### `protectedResourceMetadataHandler`

Express handler that returns OAuth protected resource metadata for Clerk integration, as required by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728). For another authorization server, return `generateProtectedResourceMetadata` from `@clerk/mcp-tools/express` in your own route.

**Options:** the options you pass to `clerkInstrumentHandler`, all optional, plus `properties`, so the auth options can be reused here. Add `properties` only when calling the metadata handler, not the auth entry point. The handler ignores `clerkClient`, `verifyToken`, and `reporting`.

- `resourceUrl` (optional) - The same value you pass to `clerkInstrumentHandler`: the exact URL clients use for the endpoint, or a list of them, one for each origin. The metadata's `resource` is then the URL `clerkInstrumentHandler` checks for the same request, and with a list a request to an origin none of them has gets a `421 Misdirected Request`. Without it, `resource` comes from the URL the metadata route was requested at, which can differ from the public URL behind a proxy, and MCP clients reject metadata whose `resource` differs from the URL they connect to.
- `requiredScopes` and `challengeScopes` (optional) - The same values you pass to `clerkInstrumentHandler`. The metadata lists `requiredScopes` then `challengeScopes`, each once, as `scopes_supported`, and leaves `scopes_supported` out when there are none.
- `properties` (optional) - Additional metadata, such as `resource_name`. It overrides the generated metadata, except `resource`, which it can't set: pass the URL as `resourceUrl`, so `resource` is the URL `clerkInstrumentHandler` checks (RFC 9728 section 3.3). Setting it throws a `Clerk error:` when the handler is created. A `scopes_supported` here is used as given, to list more scopes than the server asks for, but it must include every `requiredScopes` and `challengeScopes` entry, or the handler throws a `Clerk error:` naming the missing ones when it is created.

**Example:**

```ts
import { protectedResourceMetadataHandler } from '@clerk/mcp-tools/express';

app.all(
  '/.well-known/oauth-protected-resource/mcp',
  protectedResourceMetadataHandler({
    resourceUrl: 'https://mcp.example.com/mcp',
    requiredScopes: ['email'],
    properties: { resource_name: 'Example MCP server' },
  }),
);
```

Without `resourceUrl`, or with a list of resource URLs, an origin-form request whose immediate peer is trusted by Express's `trust proxy` policy also gets `Vary: X-Forwarded-Host, X-Forwarded-Proto`, merged with any existing `Vary`, so caches distinguish the origins those headers select. This applies even when either header is absent. A fixed `resourceUrl`, an absolute-form request-target, or an untrusted peer does not add these `Vary` fields.

Both metadata handlers send the same headers as the Next.js ones: `Cache-Control: max-age=3600` and the CORS headers in `metadataCorsHeaders`, which allow any origin, on the metadata, and the CORS headers alone, with no caching, on an error such as the `421` or `502`. Mounted for `OPTIONS` as well as `GET` (`app.all` or `app.use`, not `app.get`), each answers the CORS preflight with a `200` and those CORS headers.

`serverCardHandler` follows the same rule for a list of `resourceUrl`s, the only case where its card depends on the request's origin. For origin-form requests from a trusted proxy, these handlers select a response using the forwarded public host and scheme and set `Vary: X-Forwarded-Host, X-Forwarded-Proto`; a shared cache must honor those fields and key on the public origin, not only the internal host. This follows HTTP's `Vary` selection rules (RFC 9110 §12.5.5).

## Authorization Server Metadata

### `authorizationServerMetadataHandler`

Express handler that returns OAuth authorization server metadata for Clerk integration, as defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414). This endpoint provides clients with information about Clerk's OAuth authorization server capabilities and endpoints.

**Example:**

```ts
import { authorizationServerMetadataHandler } from '@clerk/mcp-tools/express';

// Serve authorization server metadata at the standard well-known location
app.all('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
```

**Note:** This handler requires the `CLERK_PUBLISHABLE_KEY` environment variable to be set, as it uses Clerk's public configuration to generate the metadata. A value that isn't a Clerk publishable key throws a `Clerk error:` naming the variable.

## Discovery

### `serverCardHandler`

Express handler that serves an MCP [Server Card](../README.md#discovery-server-cards). It takes the `generateServerCard` options, with `resourceUrl` as one URL or a list with one for each origin, plus `maxAge`, the seconds the card may be reused before revalidation (default `3600`; `0` for `public, no-cache`). It validates them and generates the card when it is created, throwing a `Clerk error:` for anything the card can't have, so it needs no Clerk keys or MCP SDK, and later changes to the options change nothing. Mount it with `app.all` so `OPTIONS` and other methods reach it:

```ts
import { serverCardHandler } from '@clerk/mcp-tools/express';

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

`GET` and `HEAD` get the card with a weak `ETag` and public caching, a matching `If-None-Match` gets a bodyless `304`, `OPTIONS` the CORS preflight, other methods a `405`, and a request to an origin no listed `resourceUrl` has a `421`. Every error is sent with `Cache-Control: no-store`, so no cache keeps it. The handler answers conditional requests itself, whatever the app's `etag` setting.

With a list of `resourceUrl`s, the request's origin is the one Express gives the rest of the app, `req.protocol` and `req.host`, as for `clerkInstrumentHandler`: behind a proxy, set `trust proxy` so they come from `X-Forwarded-Proto` and `X-Forwarded-Host`, which are ignored otherwise. The browser's `Origin` header plays no part. With a list, a request without a `Host` header that parses gets a `400`, since there is no origin to select by. A single `resourceUrl` never reads the request's URL, so that request still gets the card, as it does from `aiCatalogHandler`.

Express writes the discovery answer's headers over earlier values, including `Cache-Control`, `ETag`, `Content-Type`, and `Access-Control-Allow-Origin`. It merges `ETag` into an earlier `Access-Control-Expose-Headers` value without duplication, preserving `*`. A `cors` middleware mounted with `app.use` in front of it answers the `OPTIONS` preflight itself; allow `If-Match` and `If-None-Match` there, or mount the discovery routes before it.

### `aiCatalogHandler`

Express handler that serves an [AI Catalog](../README.md#discovery-ai-catalogs) linking to MCP Server Cards. It takes the `generateAICatalog` options plus `maxAge`, as `serverCardHandler` does. It validates them and generates the catalog when it is created, throwing a `Clerk error:` for anything the catalog can't have, so it needs no Clerk keys or MCP SDK, never fetches the cards it links to, and later changes to the options change nothing. Mount it with `app.all` at both [catalog paths](../README.md#discovery-ai-catalogs), `/.well-known/ard.json` and `/.well-known/ai-catalog.json`:

```ts
import { aiCatalogHandler } from '@clerk/mcp-tools/express';

app.all(
  ['/.well-known/ard.json', '/.well-known/ai-catalog.json'],
  aiCatalogHandler({
    entries: [
      {
        identifier: 'urn:air:example.com:weather',
        displayName: 'Weather',
        url: 'https://mcp.example.com/mcp/server-card',
      },
    ],
  }),
);
```

It answers as `serverCardHandler` does, with `application/ai-catalog+json`, and both paths get the same body and headers. The catalog is the same for every request, so it never answers `421`; for several origins, create one handler for each, pick it by `${req.protocol}://${req.host}` (with `trust proxy` behind a proxy), and answer `421` for an origin without one rather than serving another origin's catalog.

## MCP Request Handler

### `streamableHttpHandler`

**Deprecated.** Use [`clerkInstrumentHandler`](#clerkinstrumenthandlerhandler-options) with the handler `createMcpHandler` from `@modelcontextprotocol/server` returns. `streamableHttpHandler` doesn't report tool calls.

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

`clerkInstrumentHandler` passes the auth data to your MCP tools. MCP SDK 2.x tools read it as `ctx.http?.authInfo`, and SDK 1.x tools as the `authInfo` of their second argument:

```ts
import { isClerkAuthInfo } from '@clerk/mcp-tools/express';

server.registerTool(
  'whoami',
  { description: 'Returns the ID of the Clerk user that authorized this request' },
  async (ctx) => {
    // Narrows the auth info to the one Clerk verified, so `extra.userId` is a string
    const authInfo = ctx.http?.authInfo;
    if (!isClerkAuthInfo(authInfo)) {
      return { isError: true, content: [{ type: 'text', text: 'Not signed in with Clerk.' }] };
    }
    return { content: [{ type: 'text', text: authInfo.extra.userId }] };
  },
);
```

For custom authentication middleware, the auth data will be whatever your `verifyToken` function returns:

```ts
import type { AuthInfo } from '@modelcontextprotocol/server';

async function verifyToken(token: string, req: express.Request): Promise<AuthInfo | undefined> {
  try {
    // Check the audience: MCP servers must only accept tokens issued for them (MCP authorization spec, 2025-06-18 and later)
    const decoded = jwt.verify(token, process.env.JWT_SECRET!, {
      audience: 'https://mcp.example.com/mcp',
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    return {
      token,
      clientId: decoded.client_id ?? decoded.azp,
      scopes: typeof decoded.scope === 'string' ? decoded.scope.split(' ') : [],
      expiresAt: decoded.exp,
      extra: { userId: decoded.sub, email: decoded.email },
    };
  } catch {
    return undefined;
  }
}

server.registerTool(
  'whoami',
  { description: 'Returns the ID of the user that authorized this request' },
  async (ctx) => ({
    // The auth info is what your verifyToken function returned
    content: [{ type: 'text', text: String(ctx.http?.authInfo?.extra?.userId) }],
  }),
);
```

## Environment Variables

When using Clerk integration, make sure to set:

```bash
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

The publishable key names the Clerk instance for the OAuth metadata routes and for the default Clerk client, and the secret key lets that client verify access tokens. The default client needs both.

## Error Handling

`clerkInstrumentHandler` handles common authentication errors itself:

- **Missing Authorization header**: Returns 401 with a `WWW-Authenticate` header pointing to your protected resource metadata
- **Invalid token format**: Returns 401 with the same challenge
- **Token verification failure**: Returns 401 with the same challenge plus `error="invalid_token"`
- **Missing required scopes**: Returns 403 with the same challenge plus `error="insufficient_scope"` and `scope`
- **Verification unavailable**: Returns `{"error":"server_error"}` with the `429` or `5xx` status Clerk reported, or `500`, and logs the `McpAuthError` with `console.error`

## Integration with Existing Express Apps

These utilities are designed to integrate seamlessly with existing Express applications. You can:

- Add MCP endpoints to existing routes
- Keep your existing authentication middleware on your other routes; the MCP route needs only `clerkInstrumentHandler`
- Combine with other Express middleware (CORS, rate limiting, etc.)

```ts
import rateLimit from 'express-rate-limit';

// Apply middleware in the order you need
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(express.json());

app.all(
  '/mcp',
  clerkInstrumentHandler(createMcpHandler(createServer), { resourceUrl: MCP_RESOURCE_URL }),
);
```

### CORS for browser-based MCP clients

The metadata handlers send their own CORS headers, which allow any origin (see [`protectedResourceMetadataHandler`](#protectedresourcemetadatahandler)). `clerkInstrumentHandler` doesn't set CORS headers on `/mcp`; use Express middleware such as the `cors` package. A browser-based client needs the response to expose `WWW-Authenticate` (`Access-Control-Expose-Headers`), or it can't read the `401` challenge ([RFC 6750 section 3](https://datatracker.ietf.org/doc/html/rfc6750#section-3)) that points it to the metadata. It also sends `Authorization`, `Content-Type`, `Mcp-Protocol-Version`, and the [standard request headers](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#standard-request-headers) of the 2026-07-28 transport: `Mcp-Method` on every request, and `Mcp-Name` on `tools/call`, `resources/read`, and `prompts/get`. The preflight must allow all of them. If a tool marks a parameter with `x-mcp-header`, clients also send its `Mcp-Param-{Name}` header; add each of those names to the allowed headers too. Mount the CORS middleware before `clerkInstrumentHandler`, so it answers the `OPTIONS` preflight, which carries no token, and adds its headers to the `401` and `403`:

```ts
import cors from 'cors';

app.use(
  cors({
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Mcp-Protocol-Version',
      'Mcp-Method',
      'Mcp-Name',
    ],
    exposedHeaders: ['WWW-Authenticate'],
  }),
);
app.use(express.json());
app.all(
  '/mcp',
  clerkInstrumentHandler(createMcpHandler(createServer), {
    resourceUrl: 'https://mcp.example.com/mcp',
  }),
);
```

`createMcpHandler` is stateless and never issues an `Mcp-Session-Id`. If you serve MCP with a stateful transport of your own, also allow `Mcp-Session-Id` as a request header and expose it, and set `discoverable: false` on `clerkInstrumentHandler` (see [Public access](../README.md#public-access-sign-in-only-when-needed)).
