---
'@clerk/mcp-tools': minor
---

**Breaking:** every entry point has a new, consistent API modeled on `@clerk/express`, `@clerk/hono`, `@clerk/nextjs`, and `@clerk/backend`. Functions drop the `Clerk` suffix (Clerk is the default authorization server), configuration types end in `Options`, and the old names are removed without aliases. Each adapter (`./express`, `./hono`, `./next`) re-exports `./server`.

### Migration

| Old                                                                      | New                                                                             | Where                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------- |
| `mcpAuthClerk`                                                           | `mcpAuth({ resourceUrl })`                                                      | `./express`, `./hono`           |
| `await mcpAuth(verifyToken)`                                             | `mcpAuth({ verifyToken })`                                                      | `./express`                     |
| `mcpAuth(verifyToken)`                                                   | `mcpAuth({ verifyToken })`                                                      | `./hono`                        |
| `withMcpAuth` from `mcp-handler`                                         | `withMcpAuth(handler, { resourceUrl })`                                         | `./next`                        |
| `protectedResourceHandlerClerk(properties)`                              | `protectedResourceMetadataHandler({ resourceUrl, properties })`                 | `./express`, `./hono`, `./next` |
| `authServerMetadataHandlerClerk`                                         | `authorizationServerMetadataHandler()`                                          | `./express`, `./hono`, `./next` |
| `metadataCorsOptionsRequestHandler`                                      | `metadataCorsHandler`                                                           | `./next`                        |
| `streamableHttpHandler(server)` or `streamableHttpHandler(createServer)` | `streamableHttpHandler(createServer, StreamableHTTPServerTransport)`            | `./express`                     |
| `streamableHttpHandler(createServer)`                                    | `streamableHttpHandler(createServer, WebStandardStreamableHTTPServerTransport)` | `./hono`                        |
| `completeOAuthHandler` from `./next`                                     | `completeOAuthHandler` from `./next/client`                                     | `./next/client`                 |
| `corsHeaders`                                                            | `metadataCorsHeaders`                                                           | `./server`                      |
| `generateClerkProtectedResourceMetadata`                                 | `generateProtectedResourceMetadata`                                             | `./server`                      |
| `fetchClerkAuthorizationServerMetadata`                                  | `fetchAuthorizationServerMetadata`                                              | `./server`                      |
| `verifyClerkToken`                                                       | `toClerkAuthInfo`                                                               | `./server`, `./next`            |
| `getClientBySessionId`                                                   | `getMcpClientBySessionId`                                                       | `./client`                      |
| `completeAuthWithCode`                                                   | `completeOAuth`                                                                 | `./client`                      |
| `CreateDynamicallyRegisteredMcpClientParams`                             | `CreateDynamicallyRegisteredMcpClientOptions`                                   | `./client`                      |
| `CreateKnownCredentialsMcpClientParams`                                  | `CreateKnownCredentialsMcpClientOptions`                                        | `./client`                      |
| `McpClientReturnType`                                                    | `McpClientConnection`                                                           | `./client`                      |
| `ClientData`                                                             | `McpClientData`                                                                 | `./client`                      |
| default export of `./stores/fs`                                          | `createFsStore()`                                                               | `./stores/fs`                   |
| `./feedback`, `./create-browser-session`                                 | `./tools`                                                                       | subpath                         |
| `./stores`                                                               | `./stores/fs`, `./stores/redis`, `./stores/postgres`, `./stores/sqlite`         | subpath                         |

`mcpAuth` (and `withMcpAuth` in Next.js) takes one `McpAuthOptions` object. Without `verifyToken`, Clerk verifies the token and `resourceUrl` is required; with `verifyToken(token, req)`, return the MCP SDK's `AuthInfo` or `undefined`. `clerkClient` is optional and takes a client or a function returning one; each adapter defaults to its framework's client (Hono builds one from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` through `env(c)`). Pass the same options object to `protectedResourceMetadataHandler`.

### Behavior changes

- **Audience check.** Clerk-verified tokens must have `resourceUrl` as their audience, or they get a `401` `invalid_token` challenge. Your Clerk instance must issue `aud` (the Dashboard enables it when you add an MCP server). Peer minimums are now `@clerk/express` 2.1.70, `@clerk/nextjs` 7.9.5, and `@clerk/backend` 3.19.0.
- **Next.js metadata `resource`** comes from the route path (`<origin>/mcp` instead of the origin). Tokens issued for the origin are re-challenged; pass `resourceUrl: origin` to both handlers to keep the old behavior.
- **Protected resource metadata** holds only the RFC 9728 fields `resource`, `authorization_servers`, `bearer_methods_supported`, and your `properties`. `properties.resource` now throws; pass `resourceUrl` instead.
- **Errors.** Verifier failures other than `McpTokenVerificationError` become an `McpAuthError` answered with JSON `{"error":"server_error"}` (status `500`, or the cause's `429`/`5xx`) and logged, instead of a framework error page. A Clerk outage no longer looks like `invalid_token`.
- **Authorization server metadata.** `authorizationServerMetadataHandler()` answers a failed or slow (5 second timeout) Frontend API fetch with a JSON `502`, and a non-2xx Frontend API response is an error rather than the metadata.
- **Metadata headers.** The Express and Hono metadata handlers now send `Cache-Control: max-age=3600` and the `metadataCorsHeaders`, and answer the CORS preflight, like `./next`.
- **`streamableHttpHandler`** answers non-`POST` requests with a `405`. Mount it with `app.all('/mcp', ...)`.
- **Token checks.** Expired tokens, tokens whose auth info `resource` isn't `resourceUrl`, and requests with more than one `Authorization` header get a `401` challenge.
- **Express** `mcpAuth` no longer reads `clerkMiddleware()`'s auth; pass `clerkClient` if you configured explicit keys. It uses only the path of an absolute-form request target.
- **Hono** no longer uses `@clerk/hono` (no longer a peer), and `c.get('mcpAuth')` is typed `AuthInfo | undefined`.
- **Missing Clerk keys** throw a `Clerk error:` setup error on every request in Express and Next.js.
- **Dependencies.** `@modelcontextprotocol/sdk` and `zod` are now optional peers; list them yourself if you import the SDK or use `./tools`. `mcp-handler` (`^2.0.0`) and `@modelcontextprotocol/server` (`^2.1.0`) are declared as optional peers.

### Removed

- `protectedResourceHandler`; serve `generateProtectedResourceMetadata({ resourceUrl, authServerUrl })` from your own route.
- The `./tools` schema and helper internals (`submitFeedbackInputSchema`, `FEEDBACK_KINDS`, `browserSessionInputSchema`, and similar). Customize a tool by overriding the config `submitFeedbackTool()` or `createBrowserSessionTool()` returns.
- The `main` field of `package.json`; import a subpath.

### New

- `requiredScopes` and `challengeScopes` for scope challenges, with `403` `insufficient_scope` step-up.
- `publicAccess` lets unauthenticated clients reach listed methods, tools, resources, and prompts.
- `resourceUrl` accepts a list of URLs (one per origin); `matchResourceUrl` applies the same rule elsewhere.
- Auth failures are reported via `res.locals.mcpAuthFailure` (Express), `c.get('mcpAuthFailure')` (Hono), and `onAuthFailure` (Next.js).
- Auth info carries `resourceMetadataUrl`, and Clerk's auth object on `extra.auth` (typed by `isClerkAuthInfo` as `ClerkOAuthAuth`).
- `createBrowserSessionTool` takes `organizationId`, and tool error results carry a code in `_meta['clerk.com/error_code']`.
- New exports: `McpAuthError`, `McpTokenVerificationError`, `McpAuthOptions`, `ProtectedResourceMetadataOptions`, `McpResourceUrl`, `McpAuthFailure`, `ClerkOAuthClient`, `PublicAccess`, `McpPublicMethod`, `FeedbackKind`, `FeedbackImpact`, `CreateBrowserSessionToolOptions`, and `@clerk/mcp-tools/package.json`.
- Every `exports` subpath has a `default` condition, so `require(esm)` works. The package is still ESM-only.
- `McpClientConnection.connect` is typed `() => Promise<void>`.
- Published declarations use real export names instead of one-letter chunk aliases.
