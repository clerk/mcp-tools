---
'@clerk/mcp-tools': minor
---

`@clerk/mcp-tools/server` and `@clerk/mcp-tools/next` now export `scopeChallengeFor` (and the `ScopeChallengeHandler` type). It builds the `scopeChallenge` registration option of MCP SDK 2.1 or later from the scopes a tool needs, so any tool can send the step-up challenge.
