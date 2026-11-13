---
'@clerk/mcp-tools': minor
---

`authorizationServerMetadataHandler()` in `./express`, `./hono` and `./next` now answers with a JSON `502`, `{"error":"server_error"}`, when Clerk's authorization server metadata can't be fetched, and logs the error with `console.error`. It used to throw to the framework's error handler, which in Express sends an HTML page with the stack trace outside production. The `502` follows RFC 9110 section 15.6.3, since the failure is Clerk's Frontend API, the upstream server. In `./next` the `502` keeps the CORS headers but not the caching header the metadata gets. A publishable key that isn't one is a setup error, not Clerk's failure, so the handler throws a `Clerk error:` naming the variable instead of answering `502`.
