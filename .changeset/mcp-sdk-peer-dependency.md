---
'@clerk/mcp-tools': minor
---

**Breaking:** `@modelcontextprotocol/sdk` is now an optional peer dependency instead of a dependency, so an app on MCP SDK 2.x (`@modelcontextprotocol/server`, as `mcp-handler` 2.x uses) no longer installs SDK 1.x for this package, and an app on SDK 1.x shares its copy instead of getting a second one. When the app's 1.x SDK differed from the one this package installed, the app's `McpServer` failed to type-check against `streamableHttpHandler` in the Express and Hono adapters. `@clerk/mcp-tools/client`, `@clerk/mcp-tools/express`, and `@clerk/mcp-tools/hono` run on SDK 1.x, so an app that uses them must now list `@modelcontextprotocol/sdk` 1.29 or later in its own dependencies. `@clerk/mcp-tools/next`, `@clerk/mcp-tools/server`, `@clerk/mcp-tools/feedback`, `@clerk/mcp-tools/create-browser-session`, and the stores do not need it.

**Breaking:** `completeOAuthHandler` moved from `@clerk/mcp-tools/next` to the new `@clerk/mcp-tools/next/client`, because it runs the SDK 1.x client and would otherwise make `@clerk/mcp-tools/next` load the SDK. Replace `import { completeOAuthHandler } from '@clerk/mcp-tools/next'` with `import { completeOAuthHandler } from '@clerk/mcp-tools/next/client'`, and install `@modelcontextprotocol/sdk`.
