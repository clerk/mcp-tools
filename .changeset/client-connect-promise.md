---
'@clerk/mcp-tools': patch
---

`McpClientConnection.connect` is typed `() => Promise<void>`, as it always returned, so `await connect()` and connection errors are visible to TypeScript.
