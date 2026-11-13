---
'@clerk/mcp-tools': minor
---

`zod` is now an optional peer dependency. Only `@clerk/mcp-tools/tools` uses it, so package managers no longer install it for apps that don't. Apps that use `./tools` must list `zod` in their own dependencies: the MCP SDK depends on it too, but a package manager that doesn't hoist dependencies, such as Yarn PnP or pnpm with an isolated layout, can't resolve the SDK's copy from `@clerk/mcp-tools`. The tools' schemas must share the SDK's `zod` copy, so keep it on a version the SDK accepts (4.2 or later for `@modelcontextprotocol/server` 2.x).
