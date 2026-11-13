---
'@clerk/mcp-tools': minor
---

`zod` is now an optional peer dependency. Only `@clerk/mcp-tools/tools` uses it, so package managers no longer install it for apps that don't. Apps that use `./tools` get `zod` through the MCP SDK; its schemas must share the SDK's `zod` copy, so an app that lists `zod` itself keeps it on a version the SDK accepts (4.2 or later for `@modelcontextprotocol/server` 2.x).
