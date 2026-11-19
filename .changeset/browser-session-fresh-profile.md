---
'@clerk/mcp-tools': patch
---

The `create_browser_session` tool description now tells agents to open the link in a fresh, isolated browser profile or context with no existing session for the app. A browser that is already signed in is refused with `agent_session_forbidden`.
