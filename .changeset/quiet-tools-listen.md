---
'@clerk/mcp-tools': minor
---

`submitFeedbackTool` now works on servers built with the MCP SDK v2 (`@modelcontextprotocol/server`), as well as v1. On v2 the agent name and the default server name are attached to each report, as are the user and OAuth client ids when the request was authenticated with `verifyClerkToken`, and the tool registers without a type cast. Servers on SDK v1 are unaffected.
