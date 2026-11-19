---
'@clerk/mcp-tools': patch
---

Keep non-root trailing slashes and fragments distinct when comparing a custom token verifier's resource with `resourceUrl`, consistent with Clerk audience verification.

Warn once at auth setup when `publicAccess.tools` lists `create_browser_session`, which requires a Clerk identity: calls without a token otherwise return `not_authenticated` without starting sign-in.
