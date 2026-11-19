---
'@clerk/mcp-tools': minor
---

`submit_feedback` now asks agents to report a problem as soon as they find it and then continue the task, instead of once at the end of the task. `impact` is optional, since an agent reporting mid-task may not know how the task ends yet. A new `SUBMIT_FEEDBACK_INSTRUCTIONS` export from `@clerk/mcp-tools/tools` holds a sentence to add to your server's `instructions`. This is the wording Clerk's hosted MCP server uses, where it raised how often agents report.
