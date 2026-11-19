---
'@clerk/mcp-tools': patch
---

Included in the 0.10.0 API release: custom token verifiers whose reported resource differs from `resourceUrl` by a non-root trailing slash or includes a fragment now get `401 invalid_token`, consistent with Clerk audience verification. Previously these mismatches were accepted; root URL normalization remains supported.

Warn once at auth setup when `publicAccess.tools` lists `create_browser_session`, which requires a Clerk identity: calls without a token otherwise return `not_authenticated` without starting sign-in.
