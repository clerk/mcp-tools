---
'@clerk/mcp-tools': minor
---

Add Server Card discovery (beta). `generateServerCard` in `@clerk/mcp-tools/server` builds an MCP Server Card from a validated, supported subset of the extension: name, version, description, optional title, website, icons, repository, and namespaced JSON `_meta`, with a generated `$schema` and static streamable HTTP remote. `serverCardHandler` in `@clerk/mcp-tools/hono` and `@clerk/mcp-tools/next` serves it with public CORS, a weak `ETag` and conditional `GET`/`HEAD`, configurable public caching (an hour by default), and a `421` for an origin no listed `resourceUrl` has. Neither needs Clerk keys or an MCP SDK.

Add AI Catalog discovery (beta). `generateAICatalog` in `@clerk/mcp-tools/server` builds a minimal AI Catalog (`specVersion` `1.0`) whose entries each link one MCP Server Card by an explicit logical identifier and card URL, which may be on another host and is never fetched. `aiCatalogHandler` in `@clerk/mcp-tools/hono` and `@clerk/mcp-tools/next` serves it as `application/ai-catalog+json` with the same public CORS, conditional requests, and caching as `serverCardHandler`. The Next.js route handlers answer every method a route exports, including their own CORS preflight, so export one handler as `GET`, `HEAD`, `OPTIONS`, and the other methods.

Serve both through Express. `serverCardHandler` and `aiCatalogHandler` in `@clerk/mcp-tools/express` answer as the Hono handlers do, selecting a listed `resourceUrl` by the origin Express gives the app (`X-Forwarded-*` only under `trust proxy`), and answering a request without a `Host` header that parses with a `400`.
