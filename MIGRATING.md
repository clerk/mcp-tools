# Migrating from 0.6.x

Version 0.7.0/1.0.0 migrates `@clerk/mcp-tools` from the monolithic `@modelcontextprotocol/sdk` 1.x to the stable MCP SDK v2 packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/node` 2.0.0), targeting MCP protocol revision 2026-07-28. Servers built with this version answer both the modern `server/discover` handshake and the legacy `initialize` handshake, so existing MCP clients keep working without changes.

## 1. Update your dependencies

`@clerk/mcp-tools` no longer depends on `@modelcontextprotocol/sdk`. If your app constructs its own `McpServer` (every server-side consumer does), swap the SDK:

```bash
npm uninstall @modelcontextprotocol/sdk
npm install @modelcontextprotocol/server
```

Also check the Clerk peer dependencies: this version raises the optional peer floors to `@clerk/express@^2.1.5`, `@clerk/hono@^0.1.0`, and `@clerk/nextjs@^7.2.3`. If your app is still on `@clerk/express` 1.x (or an older `@clerk/nextjs`), npm will fail the install with an `ERESOLVE` conflict — bump the Clerk SDK first.

The codemod (maintained by the MCP project, not Clerk) handles most mechanical renames in your own code:

```bash
npx @modelcontextprotocol/codemod v1-to-v2 .
```

The codemod marks anything it cannot rewrite with `@mcp-codemod-error` comments and may leave old handler signatures (like `async (_, { authInfo })`) in place behind them. After running it, search your code for leftovers and fix them by hand using the sections below:

```bash
grep -rn '@mcp-codemod-error' .
```

## 2. Construct servers with `registerTool` and import from `@modelcontextprotocol/server`

```diff
- import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
+ import { McpServer } from '@modelcontextprotocol/server';

  const server = new McpServer({ name: 'my-server', version: '1.0.0' });

- server.tool(
-   'get_user_data',
-   'Gets data about the authenticated user',
-   {},
-   async (_, { authInfo }) => { ... },
- );
+ server.registerTool(
+   'get_user_data',
+   { description: 'Gets data about the authenticated user' },
+   async (ctx) => { ... },
+ );
```

## 3. Read auth info from `ctx.http.authInfo` in tool handlers

v1 passed `{ authInfo }` directly as the handler's second argument. v2 nests it under the HTTP context:

```diff
- async (_, { authInfo }) => {
-   const userId = authInfo?.extra?.userId as string | undefined;
+ async (ctx) => {
+   const userId = ctx.http?.authInfo?.extra?.userId as string | undefined;
```

## 4. Express: pass a server factory, not a server instance

v2 transports are constructed per-request and stateless, so `streamableHttpHandler` now takes a factory that returns a fresh `McpServer` on every call. Passing a shared instance was a latent concurrency bug in v1; in v2 it is a type error.

```diff
- const server = new McpServer({ name: 'my-server', version: '1.0.0' });
- server.tool( ... );
+ function createServer() {
+   const server = new McpServer({ name: 'my-server', version: '1.0.0' });
+   server.registerTool( ... );
+   return server;
+ }

- app.post('/mcp', mcpAuthClerk, streamableHttpHandler(server));
+ app.all('/mcp', mcpAuthClerk, streamableHttpHandler(createServer));
```

Note the `post` → `all` change. The handler answers `GET` and `DELETE` — the 2025-era session operations — with a JSON-RPC `405 Method not allowed.`, which is what legacy clients expect when a server offers no SSE stream. If you leave the route mounted as `post`, Express answers those verbs with its own HTML `404` before the handler ever sees them, and older clients get an ambiguous error instead of the graceful one.

`mcpAuth`, `mcpAuthClerk`, `protectedResourceHandler(Clerk)`, and `authServerMetadataHandlerClerk` are unchanged.

## 5. Hono: same signature, return a v2 server

The Hono adapter already took a factory, so no call-site change — but the factory must now return a v2 `McpServer` (steps 2–3 above). As with Express, mount the route with `app.all` rather than `app.post` so the handler can answer `GET`/`DELETE` with a proper `405`.

## 6. Next.js: first-party handler replaces `mcp-handler`

`@clerk/mcp-tools/next` now ships its own `streamableHttpHandler`, so the external `mcp-handler` (formerly `mcp-adapter`) package is no longer needed:

```diff
- import { createMcpHandler, withMcpAuth } from 'mcp-handler';
- import { verifyClerkToken } from '@clerk/mcp-tools/next';
+ import { streamableHttpHandler, verifyClerkToken } from '@clerk/mcp-tools/next';
+ import { McpServer } from '@modelcontextprotocol/server';
  import { auth, clerkClient } from '@clerk/nextjs/server';

- const handler = createMcpHandler((server) => {
-   server.tool( ... );
- });
- const authHandler = withMcpAuth(
-   handler,
-   async (_, token) => {
-     const clerkAuth = await auth({ acceptsToken: 'oauth_token' });
-     return verifyClerkToken(clerkAuth, token);
-   },
-   { required: true, resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp' },
- );
- export { authHandler as GET, authHandler as POST };
+ function createServer() {
+   const server = new McpServer({ name: 'my-server', version: '1.0.0' });
+   server.registerTool( ... );
+   return server;
+ }
+ const handler = streamableHttpHandler(createServer, {
+   verifyToken: async (token) => {
+     const clerkAuth = await auth({ acceptsToken: 'oauth_token' });
+     return verifyClerkToken(clerkAuth, token);
+   },
+ });
+ export { handler as GET, handler as POST, handler as DELETE };
```

Export `DELETE` alongside `GET` and `POST` so the handler — not Next's own 405 page — answers legacy session-termination requests with a JSON-RPC error body.

If you prefer to stay on `mcp-handler`, its 2.x releases also support MCP SDK v2 — `verifyClerkToken` keeps working with `withMcpAuth` as before.

## 7. Client helpers: unchanged API, plus optional `iss` validation

`createKnownCredentialsMcpClient`, `createDynamicallyRegisteredMcpClient`, `getClientBySessionId`, and `completeAuthWithCode` keep their signatures. Two things to know:

- `completeAuthWithCode` accepts an optional `iss` — the issuer identifier from the OAuth callback querystring. When present it is validated against the recorded issuer before the code is redeemed ([RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207) mix-up defense, required by the 2026-07-28 spec). Pass it if your callback route has it; the Next.js `completeOAuthHandler` does this automatically. Note that if the authorization server advertises `authorization_response_iss_parameter_supported`, omitting `iss` rejects the exchange.
- The exposed lower-level primitives (`transport`, `client`, `authProvider` on the client return value) are now the v2 classes from `@modelcontextprotocol/client`. Code that only calls `connect()` and the documented helpers is unaffected.

## 8. Session stores: no changes

The fs/redis/postgres/sqlite stores are untouched. They hold application-level OAuth state (PKCE verifiers, tokens), which the stateless v2 protocol does not replace.

## 9. Wire-level behavior notes

- Legacy (2025-era) requests are served by the SDK's stateless fallback: single-request POST exchanges work as before, but session operations (GET/DELETE with `Mcp-Session-Id`) answer `405` with `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}` — protocol sessions no longer exist. You only get that response if the route is mounted for those verbs (see step 4); otherwise your framework's own 404 handler answers first.
- `Mcp-Session-Id` is never sent or accepted. The long-lived `GET` SSE stream is replaced by `subscriptions/listen`, and the legacy JSON-RPC `ping` method is gone (`-32601`).
- Modern (2026-07-28) requests must carry the `Mcp-Method` header and the per-request `_meta` envelope. SDK clients do this automatically; only hand-rolled HTTP callers need to care.
