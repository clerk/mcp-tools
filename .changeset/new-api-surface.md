---
'@clerk/mcp-tools': minor
---

**Breaking:** every entry point has a new, consistent API, following `@clerk/express`, `@clerk/hono`, `@clerk/nextjs`, and `@clerk/backend`. Functions are named for what they do, without a `Clerk` suffix: Clerk is the default, and another authorization server is an option. Configuration types end in `Options`. The old names are removed with no deprecated aliases. Each adapter (`./express`, `./hono`, `./next`) also re-exports everything from `./server`, so a server imports from its adapter alone.

### Migration

| Old                                          | New                                                                     | Where                           |
| -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| `mcpAuthClerk`                               | `mcpAuth({ resourceUrl })`                                              | `./express`, `./hono`           |
| `mcpAuth(verifyToken, options)`              | `mcpAuth({ verifyToken, ...options })`                                  | `./express`, `./hono`           |
| `withMcpAuth` from `mcp-handler`             | `withMcpAuth(handler, { resourceUrl, clerkClient })`                    | `./next`                        |
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

`mcpAuth` (and `withMcpAuth` in Next.js) takes one `McpAuthOptions` object. Without `verifyToken`, Clerk verifies the token and `resourceUrl` is required. With `verifyToken(token, req)`, your function returns the MCP SDK's `AuthInfo`, or `undefined` to reject the token, and `resourceUrl` is optional. Pass the same options object to `protectedResourceMetadataHandler`, which ignores the verification options. In Express, `streamableHttpHandler` takes `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`. In Hono, it takes `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`.

### Behavior changes

- **Audience check.** When Clerk verifies the token, `mcpAuth` and `withMcpAuth` now check that the token's audience is `resourceUrl`. A token issued for another resource no longer passes. Set `resourceUrl` to the exact URL clients use for the endpoint. Because of this check, the peer dependencies now start at `@clerk/express` 2.1.70, `@clerk/hono` 0.1.80, `@clerk/nextjs` 7.9.5, and the optional `@clerk/backend` 3.19.0.
- **Next.js metadata `resource`.** `protectedResourceMetadataHandler` sets `resource` from the route path, so `/.well-known/oauth-protected-resource/mcp` describes `<origin>/mcp` instead of the bare origin. New tokens carry `<origin>/mcp` in `aud`. Tokens issued before the upgrade carry the origin, so `withMcpAuth` answers them with a `401` `invalid_token` challenge and the client authorizes again. To keep the origin as the resource instead, pass `resourceUrl: origin` to both `withMcpAuth` and `protectedResourceMetadataHandler`, and serve the metadata at the root `app/.well-known/oauth-protected-resource/route.ts`, where `withMcpAuth`'s challenge then points.
- **Protected resource metadata fields.** Metadata now holds only `resource`, `authorization_servers`, `bearer_methods_supported`, and any `properties`, as RFC 9728 section 2 defines them. `jwks_uri`, `token_types_supported`, the `token_introspection_*` fields, `authorization_data_*`, and `key_challenges_supported` are removed. `service_documentation` is now `resource_documentation`. `scopes_supported` defaults to `requiredScopes` plus `challengeScopes`. A `scopes_supported` you pass must include all of them.
- **Errors.** When a verifier throws anything other than `McpTokenVerificationError`, the error is wrapped in an `McpAuthError` with `reason: 'verification_failed'`, and the original error is its `cause`. In Express, a `5xx` `status` on the cause is kept, and any other status becomes `500`. Hono and Next.js answer with `500`. When Clerk cannot verify an opaque token at all, for example during an outage, the result is a `500` instead of `invalid_token`, so clients keep a valid token.
- **Authorization server metadata errors.** `fetchAuthorizationServerMetadata`, and so `authorizationServerMetadataHandler`, now throws a `Clerk error:` when the Frontend API answers with a non-2xx status, instead of serving its error body as the metadata.
- **Expired tokens.** A token whose `expiresAt` has passed now gets an `invalid_token` challenge, even when `verifyToken` returned its auth info.
- **MCP SDK.** `@modelcontextprotocol/sdk` is now an optional peer dependency. The server entry points never import it. `./client` and `./next/client` require it at 1.29 or later in your own dependencies.

### Removed

- `protectedResourceHandler`, the metadata handler for an authorization server other than Clerk. For another server, serve `generateProtectedResourceMetadata({ resourceUrl, authServerUrl })` from your own route.
- The tool constants and schemas `SUBMIT_FEEDBACK_TOOL_NAME`, `SUBMIT_FEEDBACK_DESCRIPTION`, `submitFeedbackInputSchema`, `FEEDBACK_KINDS`, `FEEDBACK_IMPACTS`, `FeedbackToolExtra`, `CREATE_BROWSER_SESSION_TOOL_NAME`, `browserSessionInputSchema`, `browserSessionToolText`, `browserSessionErrorMessage`, and `validateBrowserSessionOptions`. Register a tool with `server.registerTool(...submitFeedbackTool({ secretKey }))`.
- The `main` field of `package.json`. Import a subpath.

### New

- `challengeScopes` adds scopes to the `401` challenge without requiring them. `requiredScopes` are listed too, and a token missing them gets a `403` `insufficient_scope` challenge.
- `resourceUrl` can be a list of URLs, one for each origin. A request to an origin that is not listed gets a `421`. `matchResourceUrl` applies the same rule in a route of your own.
- Auth failures are reported for logging: in `res.locals.mcpAuthFailure` in Express, in `c.get('mcpAuthFailure')` in Hono, and through `onAuthFailure(failure, req)` in Next.js.
- In Hono, `mcpAuth({ resourceUrl })` works without `clerkMiddleware()`. It builds a client from `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` through `env(c)`, which requires `@clerk/backend`.
- The auth info now carries `resourceMetadataUrl`, which MCP SDK 2 step-up challenges need.
- New exports: `McpAuthError`, `McpTokenVerificationError`, and the `McpAuthOptions`, `ProtectedResourceMetadataOptions`, `McpResourceUrl`, `McpAuthFailure`, and `ClerkOAuthClient` types. `@clerk/mcp-tools/package.json` is importable.
