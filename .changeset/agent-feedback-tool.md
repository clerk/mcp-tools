---
'@clerk/mcp-tools': minor
---

Add `@clerk/mcp-tools/feedback`, which registers a `submit_feedback` tool that stores agent feedback on your Clerk instance so you can review it in the Clerk Dashboard.

`verifyClerkToken` now marks its result with `extra.verifiedBy: 'clerk'`, and the new `isClerkAuthInfo()` from `@clerk/mcp-tools/server` checks for it.
