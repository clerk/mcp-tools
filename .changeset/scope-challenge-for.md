---
'@clerk/mcp-tools': minor
---

`@clerk/mcp-tools/server` and `@clerk/mcp-tools/next` now export `scopeChallengeFor`. It builds the `scopeChallenge` registration option of MCP SDK 2.1 or later from the scopes a tool needs, passed as separate arguments (`scopeChallengeFor('projects:read', 'projects:write')`), so any tool can send the step-up challenge. `assertScopes(ctx, challenge)` checks the same scopes inside the tool, for requests the SDK does not challenge. On SDK 1.x it takes the scopes directly: `assertScopes(ctx, 'projects:read')`.
