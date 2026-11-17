---
'@clerk/mcp-tools': minor
---

**Breaking:** the existing APIs are replaced by a consolidated API across every entry point, modeled on the Clerk SDKs. Functions drop the `Clerk` suffix, `mcpAuth`, `withClerkMcpAuth` and the metadata handlers share one options object, and each adapter re-exports `./server`. The old names are removed without deprecated aliases; see the README for details.

| Old                                                                      | New                                                                             | Where                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------- |
| `mcpAuthClerk`                                                           | `mcpAuth({ resourceUrl })`                                                      | `./express`, `./hono`           |
| `await mcpAuth(verifyToken)`                                             | `mcpAuth({ verifyToken })`                                                      | `./express`                     |
| `mcpAuth(verifyToken)`                                                   | `mcpAuth({ verifyToken })`                                                      | `./hono`                        |
| `withMcpAuth` from `mcp-handler`                                         | `withClerkMcpAuth(handler, { resourceUrl })`                                    | `./next`                        |
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

Other breaking changes:

- Clerk-verified tokens must have `resourceUrl` as their audience (`aud`), or they get a `401`. The check accepts the forms Clerk issues for it, including the one that keeps a default port with a lowercased scheme and host, so `https://MCP.example.com:443/mcp` matches an `aud` of `https://mcp.example.com:443/mcp`. Peer minimums are now `@clerk/express` 2.1.70, `@clerk/nextjs` 7.9.5, and `@clerk/backend` 3.19.0.
- In Next.js, the protected resource metadata's `resource` is `<origin>/mcp` (from the route path) instead of the origin, so tokens issued for the origin are re-challenged.
- A custom `verifyToken` must return a finite `expiresAt` and a non-empty `clientId`, or the token gets a `401` `invalid_token` challenge (cause code `token-claims-missing`). MCP authorization 2025-06-18 and later has servers validate tokens per OAuth 2.1 section 5.2, which includes checking expiry, and RFC 9068 section 2.2 makes `exp` and `client_id` REQUIRED in a JWT access token. Auth info from `toClerkAuthInfo` needs no `expiresAt`. A NaN or infinite `expiresAt` also gets `token-claims-missing`, not `token-expired`, including on auth info from `toClerkAuthInfo`. Catch the errors your JWT library throws for a token it rejects, such as `JWTExpired` from `jose`, and return `undefined` or throw an `McpTokenVerificationError`, so the token gets the `401` challenge; any other error the verifier throws gets a `server_error` answer, and the client keeps the token.
- `@modelcontextprotocol/sdk` and `zod` are now optional peers; list them in your own dependencies if you import the SDK or use `./tools`.
