---
'@clerk/mcp-tools': patch
---

Preserve `ETag` exposure and `Cache-Control: no-store` on discovery responses when earlier middleware sets CORS or cache headers.
