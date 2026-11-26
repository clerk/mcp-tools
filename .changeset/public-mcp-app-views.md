---
'@clerk/mcp-tools': minor
---

MCP App views are public by default. `@clerk/mcp-tools/tools` adds `mcpAppViewResource(options)`, which returns arguments for `server.registerResource(...)` on MCP SDK 1.x or 2.x: it serves the HTML as `text/html;profile=mcp-app`, takes the CSP as `connectDomains`, `resourceDomains`, `frameDomains`, and `baseUriDomains` origin lists (rejecting `*` and bare schemes, and leaving an empty CSP out), puts `_meta.ui` on the read content item, and logs a one-time `Clerk warning:` for a template without `<!DOCTYPE html>` or `color-scheme`, or with a Clerk secret key.

`mcpAuth` and `withClerkMcpAuth` take `publicAccess.views`, which lets a `resources/read` or `subscriptions/listen` without a token reach exactly the views `mcpAppViewResource` built, so MCP Apps hosts can prefetch view templates before the user signs in and scanners can inspect them. Other `ui://` resources and every other resource keep their rule. See `PublicAccess.views` for its default. Build each view at module scope so its URI is known before the first request. For a server that renders per-user data into its templates, set `publicAccess: { views: false }`; `publicAccess.resources` can still open single views by URI.
