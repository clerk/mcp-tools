---
'@clerk/mcp-tools': minor
---

`streamableHttpHandler` in `@clerk/mcp-tools/express` and `@clerk/mcp-tools/hono` now logs one `console.warn` per process when a handler is created, and its `@deprecated` tag says why: it is the MCP SDK 1.x path, which can't serve protocol revision 2026-07-28 or `server/discover`, so clients fall back to an older revision. Build your server with MCP SDK 2.x (`@modelcontextprotocol/server`) and serve the handler `createMcpHandler` returns with `clerkInstrumentHandler(handler, options)`. The handler keeps working until it is removed in 2.0, and `@modelcontextprotocol/sdk` stays an optional peer until then.
