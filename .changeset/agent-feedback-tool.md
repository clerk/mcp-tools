---
'@clerk/mcp-tools': minor
---

Add `@clerk/mcp-tools/feedback`, whose `submitFeedbackTool()` builds a `submit_feedback` tool (`server.registerTool(...submitFeedbackTool({ secretKey }))`) that stores agent feedback on your Clerk instance so you can review it in the Clerk Dashboard.

`verifyClerkToken` now marks its result with `extra.verifiedBy: 'clerk'`, and the new `isClerkAuthInfo()` from `@clerk/mcp-tools/server` checks for it.
