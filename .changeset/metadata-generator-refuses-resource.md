---
'@clerk/mcp-tools': minor
---

**Breaking:** `generateProtectedResourceMetadata` now throws a `Clerk error:` when `properties` has its own `resource` key, even one set to `undefined`, as `protectedResourceMetadataHandler` in `./express`, `./hono` and `./next` already did at setup. `properties.resource` used to replace `resourceUrl`, so the metadata could name a resource other than the one the server protects, and a client discards metadata whose `resource` is not the URL it derived the metadata URL from (RFC 9728 section 3.3). When upgrading, remove `resource` from `properties` and pass that URL as `resourceUrl`.
