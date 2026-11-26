---
'@clerk/mcp-tools': patch
---

Server Card and AI Catalog handlers now answer the CORS preflight with `Access-Control-Max-Age: 86400`, as the metadata handlers do, so a browser revalidating with `If-None-Match` no longer sends a preflight before nearly every request.
