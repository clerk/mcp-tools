---
'@clerk/mcp-tools': minor
---

Add a `resource` option to `verifyClerkToken(auth, token, { resource })`. When set, tokens whose `aud` claim does not include the resource are rejected, for both JWT and opaque tokens, and the returned `AuthInfo` carries the bound `resource`. This relies on the `aud` field of the OAuth auth object from the `@clerk/backend` release that enforces audience binding; with older versions every token is rejected once `resource` is set. Without `resource`, behavior is unchanged.
