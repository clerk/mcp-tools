---
'@clerk/mcp-tools': patch
---

Raise the optional `@modelcontextprotocol/sdk` peer and development dependency floors to `^1.32.0` for upstream security fixes. Preserve the SDK's issuer-bound OAuth client information and tokens across stored sessions. HTTP clients use the SDK's safer redirect policy; configure the final MCP endpoint URL when a deployment redirects across origins (or redirects in a browser).
