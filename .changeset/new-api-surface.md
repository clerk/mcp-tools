---
'@clerk/mcp-tools': minor
---

**Breaking:** every entry point has a new, consistent API, following `@clerk/express`, `@clerk/hono`, `@clerk/nextjs`, and `@clerk/backend`. Functions are named for what they do, without a `Clerk` suffix: Clerk is the default, and another authorization server is an option. Configuration types end in `Options`. The old names are removed with no deprecated aliases. Each adapter (`./express`, `./hono`, `./next`) also re-exports everything from `./server`, so a server imports from its adapter alone.

### Migration

| Old                                          | New                                                                     | Where                           |
| -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| `mcpAuthClerk`                               | `mcpAuth({ resourceUrl })`                                              | `./express`, `./hono`           |
| `mcpAuth(verifyToken, options)`              | `mcpAuth({ verifyToken, ...options })`                                  | `./express`, `./hono`           |
| `withMcpAuth` from `mcp-handler`             | `withMcpAuth(handler, { resourceUrl })`                                 | `./next`                        |
| `protectedResourceHandlerClerk(properties)`  | `protectedResourceMetadataHandler({ resourceUrl, properties })`         | `./express`, `./hono`, `./next` |
| `authServerMetadataHandlerClerk`             | `authorizationServerMetadataHandler()`                                  | `./express`, `./hono`, `./next` |
| `metadataCorsOptionsRequestHandler`          | `metadataCorsHandler`                                                   | `./next`                        |
| `streamableHttpHandler(server)`              | `streamableHttpHandler(() => createServer(), Transport)`                | `./express`, `./hono`           |
| `completeOAuthHandler` from `./next`         | `completeOAuthHandler` from `./next/client`                             | `./next/client`                 |
| `corsHeaders`                                | `metadataCorsHeaders`                                                   | `./server`                      |
| `generateClerkProtectedResourceMetadata`     | `generateProtectedResourceMetadata`                                     | `./server`                      |
| `fetchClerkAuthorizationServerMetadata`      | `fetchAuthorizationServerMetadata`                                      | `./server`                      |
| `verifyClerkToken`                           | `toClerkAuthInfo`                                                       | `./server`                      |
| `getClientBySessionId`                       | `getMcpClientBySessionId`                                               | `./client`                      |
| `completeAuthWithCode`                       | `completeOAuth`                                                         | `./client`                      |
| `CreateDynamicallyRegisteredMcpClientParams` | `CreateDynamicallyRegisteredMcpClientOptions`                           | `./client`                      |
| `CreateKnownCredentialsMcpClientParams`      | `CreateKnownCredentialsMcpClientOptions`                                | `./client`                      |
| `McpClientReturnType`                        | `McpClientConnection`                                                   | `./client`                      |
| `ClientData`                                 | `McpClientData`                                                         | `./client`                      |
| default export of `./stores/fs`              | `createFsStore()`                                                       | `./stores/fs`                   |
| `./feedback`, `./create-browser-session`     | `./tools`                                                               | subpath                         |
| `./stores`                                   | `./stores/fs`, `./stores/redis`, `./stores/postgres`, `./stores/sqlite` | subpath                         |

`mcpAuth` (and `withMcpAuth` in Next.js) takes one `McpAuthOptions` object. Without `verifyToken`, Clerk verifies the token and `resourceUrl` is required. `clerkClient` is optional in every adapter: it defaults to `clerkClient` from `@clerk/express` in Express, a client built from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in Hono, and `clerkClient` from `@clerk/nextjs/server`, loaded on the first request, in Next.js. With `verifyToken(token, req)`, your function returns the MCP SDK's `AuthInfo`, or `undefined` to reject the token, and `resourceUrl` is optional. Pass the same options object to `protectedResourceMetadataHandler`, which ignores the verification options. In Express, `streamableHttpHandler` takes `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`. In Hono, it takes `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`.

### Behavior changes

- **Audience check.** When Clerk verifies the token, `mcpAuth` and `withMcpAuth` now check that the token's audience is `resourceUrl`. A token issued for another resource no longer passes. Set `resourceUrl` to the exact URL clients use for the endpoint. Because of this check, the peer dependencies now start at `@clerk/express` 2.1.70, `@clerk/nextjs` 7.9.5, and the optional `@clerk/backend` 3.19.0.
- **Next.js metadata `resource`.** `protectedResourceMetadataHandler` sets `resource` from the route path, so `/.well-known/oauth-protected-resource/mcp` describes `<origin>/mcp` instead of the bare origin. New tokens carry `<origin>/mcp` in `aud`. Tokens issued before the upgrade carry the origin, so `withMcpAuth` answers them with a `401` `invalid_token` challenge and the client authorizes again. To keep the origin as the resource instead, pass `resourceUrl: origin` to both `withMcpAuth` and `protectedResourceMetadataHandler`, and serve the metadata at the root `app/.well-known/oauth-protected-resource/route.ts`, where `withMcpAuth`'s challenge then points.
- **Protected resource metadata fields.** Metadata now holds only `resource`, `authorization_servers`, `bearer_methods_supported`, and any `properties`, as RFC 9728 section 2 defines them. `jwks_uri`, `token_types_supported`, the `token_introspection_*` fields, `authorization_data_*`, and `key_challenges_supported` are removed. `service_documentation` is now `resource_documentation`. `scopes_supported` defaults to `requiredScopes` plus `challengeScopes`. A `scopes_supported` you pass must include all of them.
- **Errors.** When a verifier throws anything other than `McpTokenVerificationError`, the error is wrapped in an `McpAuthError` with `reason: 'verification_failed'`, and the original error is its `cause`. The `McpAuthError`'s `status` is the cause's `status` only when it is an integer from `500` to `599`, and Express and Hono answer with it, or with `500` when it has none. Next.js answers with `500`. When Clerk cannot verify an opaque token at all, for example during an outage, the result is a `500` instead of `invalid_token`, so clients keep a valid token.
- **Authorization server metadata errors.** `fetchAuthorizationServerMetadata`, and so `authorizationServerMetadataHandler`, now throws a `Clerk error:` when the Frontend API answers with a non-2xx status, instead of serving its error body as the metadata.
- **Expired tokens.** A token whose `expiresAt` has passed now gets an `invalid_token` challenge, even when `verifyToken` returned its auth info.
- **Express `clerkMiddleware()`.** The Express `mcpAuth` no longer reads the auth that `clerkMiddleware()` set through `getAuth()`. Without `clerkClient`, it verifies each token itself with `clerkClient` from `@clerk/express`, which reads `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from the environment. If you configured `clerkMiddleware()` with explicit keys or a client instead, pass a client to `mcpAuth` too, as `mcpAuth({ resourceUrl, clerkClient: createClerkClient({ secretKey, publishableKey }) })` with `createClerkClient` from `@clerk/express`. `clerkMiddleware()` is no longer needed on the MCP route, and left there it verifies each token a second time. `@clerk/express` is now loaded on the first request, and only when `mcpAuth` uses that default client, so an app that passes `verifyToken` or `clerkClient` no longer needs it installed.
- **`@clerk/hono`.** The Hono adapter no longer uses `@clerk/hono`, and it is no longer a peer dependency. Without `clerkClient`, `mcpAuth` builds its own client and ignores one that `clerkMiddleware()` set.
- **Hono `mcpAuth` variable.** `c.get('mcpAuth')` is now typed `AuthInfo | undefined`, because a request that `publicAccess` lets through has no auth info.
- **Next.js Pages Router.** The Next.js handlers are App Router route handlers. The README no longer suggests they work from Pages Router API routes, which they never did.
- **MCP SDK.** `@modelcontextprotocol/sdk` is now an optional peer dependency. The server entry points never import it. `./client` and `./next/client` require it at 1.29 or later in your own dependencies.

### Removed

- `protectedResourceHandler`, the metadata handler for an authorization server other than Clerk. For another server, serve `generateProtectedResourceMetadata({ resourceUrl, authServerUrl })` from your own route.
- The tool schemas and helpers `SUBMIT_FEEDBACK_DESCRIPTION`, `submitFeedbackInputSchema`, `FEEDBACK_KINDS`, `FEEDBACK_IMPACTS`, `FeedbackToolExtra`, `browserSessionInputSchema`, `browserSessionToolText`, `browserSessionErrorMessage`, and `validateBrowserSessionOptions`. Register a tool with `server.registerTool(...submitFeedbackTool({ secretKey }))`, and customise it by overriding the config it returns and wrapping its callback. Use the `FeedbackKind` and `FeedbackImpact` types in place of `FEEDBACK_KINDS` and `FEEDBACK_IMPACTS`. `SUBMIT_FEEDBACK_TOOL_NAME` and `CREATE_BROWSER_SESSION_TOOL_NAME` are still exported.
- The `main` field of `package.json`. Import a subpath.

### New

- `challengeScopes` adds scopes to the `401` challenge without requiring them. `requiredScopes` are listed too, and a token missing them gets a `403` `insufficient_scope` challenge.
- `publicAccess` on `mcpAuth` and `withMcpAuth` names what a request without a token may do: `methods` (`true`, or a list of protocol and list methods), `tools` (tool names), and `resources` and `prompts` (`true`, or a list of resource URIs or prompt names). A client can then connect and call the tools you list without signing in, and gets the `401` challenge when it reaches anything else. Nothing is open without it. With the handshake open, a `GET` without a token gets a `405` instead of the challenge, so a client does not start authorization by opening its stream. In Express, mount `express.json()` before `mcpAuth` to use it. The new `PublicAccess` and `McpPublicMethod` types are exported from `./server` and every adapter.
- `resourceUrl` can be a list of URLs, one for each origin. A request to an origin that is not listed gets a `421`. `matchResourceUrl` applies the same rule in a route of your own.
- Auth failures are reported for logging: in `res.locals.mcpAuthFailure` in Express, in `c.get('mcpAuthFailure')` in Hono, and through `onAuthFailure(failure, req)` in Next.js. `onAuthFailure` is a synchronous notification whose return value is ignored; schedule asynchronous logging with Next.js `after()` to keep it alive after the response without delaying the challenge.
- In Hono, `mcpAuth({ resourceUrl })` works without `clerkMiddleware()`. It builds a client from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` through `env(c)`, which requires `@clerk/backend`.
- The auth info now carries `resourceMetadataUrl`, which MCP SDK 2 step-up challenges need.
- Auth info from `toClerkAuthInfo`, and so from Clerk verification in `mcpAuth` and `withMcpAuth`, keeps Clerk's own auth object for the token on `extra.auth`, with fields such as `id`, `subject`, and `getToken()`. After `isClerkAuthInfo(authInfo)`, it is typed as the new `ClerkOAuthAuth`. `toClerkAuthInfo` returns `undefined` for an auth object without `id`, `subject`, or `getToken`, which Clerk always sets.
- New exports: `McpAuthError`, `McpTokenVerificationError`, and the `McpAuthOptions`, `ProtectedResourceMetadataOptions`, `McpResourceUrl`, `McpAuthFailure`, and `ClerkOAuthClient` types. `@clerk/mcp-tools/package.json` is importable.
- `createBrowserSessionTool` takes `organizationId`, an ID or a function that returns one for each call from the verified auth info, run after the auth, scope, and path checks. Its options type is the new `CreateBrowserSessionToolOptions`.
- `create_browser_session` error results carry the `BrowserSessionErrorCode` in `_meta['clerk.com/error_code']`, so a wrapper can tell failures apart without reading the text.
- New `./tools` types: `FeedbackKind`, `FeedbackImpact`, and `CreateBrowserSessionToolOptions`. `FeedbackReport.kind` and `impact` are typed with them, and still accept other slugs.
