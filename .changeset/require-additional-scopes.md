---
'@clerk/mcp-tools': minor
---

`@clerk/mcp-tools/server` and `@clerk/mcp-tools/next` now export `requireAdditionalScopes`. It builds the `scopeChallenge` registration option of MCP SDK 2.1 or later from the scopes a tool needs, passed as separate arguments (`requireAdditionalScopes('projects:read', 'projects:write')`), so any tool can send the step-up challenge.
