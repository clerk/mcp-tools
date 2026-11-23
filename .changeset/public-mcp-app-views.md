---
'@clerk/mcp-tools': minor
---

MCP App views are public by default on a discoverable server. `mcpAuth` and `withClerkMcpAuth` now let a `resources/read` without a token ask for any `ui://` URI whenever the server is discoverable (`discoverable` left out or `true`, or a `publicAccess.methods` list that includes `resources/list` and `initialize` or `server/discover`), so MCP Apps hosts can prefetch view templates before the user signs in and scanners can inspect them. Other resources keep their rule. To opt out, for a server that renders per-user data into its templates, set `publicAccess: { views: false }`; `publicAccess.resources` can still open single views by URI.

`@clerk/mcp-tools/tools` adds `mcpAppViewResource(options)`, which returns arguments for `server.registerResource(...)` on MCP SDK 1.x or 2.x: it serves the HTML as `text/html;profile=mcp-app`, takes the CSP as `connectDomains`, `resourceDomains`, `frameDomains`, and `baseUriDomains` origin lists (rejecting `*` and bare schemes, and leaving an empty CSP out), puts `_meta.ui` on the read content item, and logs a one-time `Clerk warning:` for a template without `<!DOCTYPE html>` or `color-scheme`, or with a Clerk secret key.
