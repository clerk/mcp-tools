---
'@clerk/mcp-tools': minor
---

ARD discovery: `aiCatalogHandler` in the Hono, Express, and Next.js adapters now serves a request whose path ends in `/.well-known/ard.json` as `application/json`, the media type the ARD publishing guide uses, and keeps `application/ai-catalog+json` for `/.well-known/ai-catalog.json` and any other path. One handler still serves both paths, with the same body, `ETag`, caching, CORS, and conditional requests. Catalog entries take `representativeQueries`, a list of 1 to 20 sample requests (ARD recommends 2 to 5), catalogs take a `host` (`{ displayName, identifier, documentationUrl? }`). The README shows the homepage's `Link: </.well-known/ard.json>; rel="ard"` header.

Default change: an entry without a `trustManifest` whose `identifier` is `urn:air:<domain>:<name>` now gets `{ identity: 'https://<domain>', identityType: 'https' }`, the trust domain ARD v0.91 section 4.5.1 binds the entry to. Set `trustManifest: null` to keep publishing none.
