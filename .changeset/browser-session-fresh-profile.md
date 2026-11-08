---
'@clerk/mcp-tools': patch
---

`create_browser_session` now tells agents to open the link in a browser that is not signed in to the app, such as a fresh profile or private window. Clerk refuses the link in a browser that already has a session.
