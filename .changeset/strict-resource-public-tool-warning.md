---
'@clerk/mcp-tools': patch
---

Included in the 0.10.0 API release, narrowing the URL normalization of the new custom `verifyToken` resource check: a non-root trailing slash and a fragment stay significant, consistent with Clerk audience verification. A reported resource that differs from `resourceUrl` only by a non-root trailing slash, or that includes a fragment, gets `401 invalid_token`. Letter case in the scheme and host, default ports and the root path's trailing slash are still normalized.

Warn once at auth setup when `publicAccess.tools` lists `create_browser_session`, which requires a Clerk identity: calls without a token otherwise return `not_authenticated` without starting sign-in.
