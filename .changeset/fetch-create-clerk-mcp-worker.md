---
'@clerk/mcp-tools': minor
---

Add `createClerkMcpWorker` to `@clerk/mcp-tools/fetch`, which serves an authenticated MCP server from a plain `fetch` Worker in a few lines. It takes `resourceUrl`, the auth options of `withClerkMcpAuth`, and a `server` factory that is called for each request with the verified `authInfo` and the Worker `env` and returns an MCP SDK 2.x `McpServer`. It returns a Worker export whose `fetch(request, env, ctx)` serves MCP through `createMcpHandler` from `@modelcontextprotocol/server`, including protocol 2026-07-28 and `server/discover`, behind the same `401` challenge and protected resource metadata as `withClerkMcpAuth`. MCP SDK 2.x is loaded on the first request, so Workers that only use `withClerkMcpAuth` still need no MCP SDK installed.
