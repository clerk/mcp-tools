---
'@clerk/mcp-tools': minor
---

ARD discovery: add `ardHandler` to the Hono, Express, and Next.js adapters, which serves the AI Catalog at `/.well-known/ard.json` as `application/json`, the media type the ARD publishing guide uses, with the same caching, CORS, and conditional requests as `aiCatalogHandler`, which keeps `application/ai-catalog+json` for `/.well-known/ai-catalog.json`. Mount `ardHandler` at `ard.json` and `aiCatalogHandler` at `ai-catalog.json` with the same options. Catalog entries take `representativeQueries` (ARD recommends 2 to 5), catalogs take a `host` (`{ displayName, identifier, documentationUrl? }`), and `ardLinkHeader()` returns the `</.well-known/ard.json>; rel="ard"` value for the homepage's `Link` header.

Default change: an entry without a `trustManifest` whose `identifier` is `urn:air:<domain>:<name>` now gets `{ identity: 'https://<domain>', identityType: 'https' }`, the trust domain ARD v0.91 section 4.5.1 binds the entry to. Set `trustManifest: null` to keep publishing none.
