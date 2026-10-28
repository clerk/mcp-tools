---
'@clerk/mcp-tools': minor
---

Add `@clerk/mcp-tools/sign-in-link`, whose `signInLinkTool` gives agents a one-time link that opens your app signed in as the user.

`isClerkAuthInfo` from `@clerk/mcp-tools/server` is now a type guard, and it also requires a non-empty `extra.userId`.
