---
'@clerk/mcp-tools': patch
---

Warn once at auth setup when `publicAccess.tools` lists `create_browser_session`, which requires a Clerk identity: calls without a token otherwise return `not_authenticated` without starting sign-in.
