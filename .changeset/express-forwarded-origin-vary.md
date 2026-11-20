---
'@clerk/mcp-tools': patch
---

Fix Express protected resource metadata caching when `resourceUrl` is omitted or a list: origin-form requests from a trusted proxy vary on `X-Forwarded-Host` and `X-Forwarded-Proto`, preserving existing `Vary` fields so shared caches distinguish forwarded origins.
