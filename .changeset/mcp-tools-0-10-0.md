---
'@clerk/mcp-tools': minor
---

**Breaking:** the existing APIs are replaced by a consolidated API across every entry point, modeled on the Clerk SDKs. Functions drop the `Clerk` suffix, `mcpAuth`, `withMcpAuth` and the metadata handlers share one options object, and each adapter re-exports `./server`. The old names are removed without deprecated aliases; see the README for details.

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
