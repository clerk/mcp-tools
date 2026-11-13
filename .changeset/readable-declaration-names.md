---
'@clerk/mcp-tools': patch
---

The published `.d.mts` and `.mjs` files now import shared code under its real names, such as `McpAuthError`, instead of one-letter chunk aliases, so go-to-definition and hover in editors show readable names.
