---
'@clerk/mcp-tools': patch
---

`mcp-handler` (`^2.0.0`) and `@modelcontextprotocol/server` (`^2.1.0`) are now declared as optional peer dependencies, so package managers warn when `./next` or `requireAdditionalScopes` step-up is used with an unsupported version.
