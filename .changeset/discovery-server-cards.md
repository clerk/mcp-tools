---
'@clerk/mcp-tools': minor
---

Add Server Card discovery (beta). `generateServerCard` in `@clerk/mcp-tools/server` builds an MCP Server Card from a validated, supported subset of the extension: name, version, description, optional title, website, icons, repository, and namespaced JSON `_meta`, with a generated `$schema` and static streamable HTTP remote. `serverCardHandler` in `@clerk/mcp-tools/hono` serves it with public CORS, a weak `ETag` and conditional `GET`/`HEAD`, configurable public caching (an hour by default), and a `421` for an origin no listed `resourceUrl` has. Neither needs Clerk keys or an MCP SDK.
