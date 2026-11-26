---
'@clerk/mcp-tools': minor
---

Add `createClerkMcpWorker` to `@clerk/mcp-tools/fetch`, which serves an authenticated MCP server from a plain `fetch` Worker in a few lines. It takes `resourceUrl`, the other options of `clerkInstrumentHandler`, `reporting` included, and a `server` factory that is called for each request with the verified `authInfo` and the Worker `env` and returns an MCP SDK 2.x `McpServer`; it gets no `ctx`, as one MCP handler serves every request with the same `env`. It returns a Worker export whose `fetch(request, env, ctx)` serves MCP through `createMcpHandler` from `@modelcontextprotocol/server`, including protocol 2026-07-28 and `server/discover`, behind `clerkInstrumentHandler`, and treats every other path as the MCP endpoint. With `reporting`, it passes each server the factory returns to `clerkInstrumentServer`. MCP SDK 2.x is loaded on the first request, so Workers that only use `clerkInstrumentHandler` still need no MCP SDK installed.
