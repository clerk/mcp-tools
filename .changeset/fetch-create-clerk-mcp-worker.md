---
'@clerk/mcp-tools': minor
---

Add `createClerkMcpWorker` to `@clerk/mcp-tools/fetch`, which serves an authenticated MCP server from a plain `fetch` Worker in a few lines. It takes `resourceUrl`, the auth options of `withClerkMcpAuth`, and a `server` factory that is called for each request with the verified `authInfo` and the Worker `env` and returns an MCP SDK 2.x `McpServer`; it gets no `ctx`, as one MCP handler serves every request with the same `env`. It returns a Worker export whose `fetch(request, env, ctx)` serves MCP through `createMcpHandler` from `@modelcontextprotocol/server`, including protocol 2026-07-28 and `server/discover`, behind the same `401` challenge and protected resource metadata as `withClerkMcpAuth`, and treats every other path as the MCP endpoint. MCP SDK 2.x is loaded on the first request, so Workers that only use `withClerkMcpAuth` still need no MCP SDK installed.
