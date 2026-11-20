---
'@clerk/mcp-tools': minor
---

Document serving the AI Catalog at `/.well-known/ard.json`, the canonical path in Agentic Resource Discovery v0.91 section 5.1, as well as at its predecessor path `/.well-known/ai-catalog.json`. Mount one `aiCatalogHandler` at both paths, in Express, Hono, or Next.js, and both answer with the same body, `ETag`, caching, and CORS headers; the handler needs no configuration for either path.
