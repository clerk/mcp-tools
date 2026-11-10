---
'@clerk/mcp-tools': minor
---

`@modelcontextprotocol/sdk` is now a peer dependency instead of a dependency, so `@clerk/mcp-tools` uses the app's copy of the SDK instead of installing its own. When the app's 1.x SDK differed from the one this package installed, the app's `McpServer` failed to type-check against `streamableHttpHandler` in the Express and Hono adapters. npm 7 or later and pnpm install the peer automatically; with other package managers, add `@modelcontextprotocol/sdk` 1.29 or later to the app's dependencies.
