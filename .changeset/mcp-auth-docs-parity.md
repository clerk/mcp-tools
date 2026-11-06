---
'@clerk/mcp-tools': minor
---

`@clerk/mcp-tools/express` and `@clerk/mcp-tools/hono` now export `clerkMcpAuth({ resourceUrl, requiredScopes })`, which verifies OAuth access tokens with Clerk and checks that their audience is `resourceUrl`. `mcpAuthClerk` does not check the audience and is deprecated. Use `@clerk/express` 2.1.70 or `@clerk/hono` 0.1.80 or later: on earlier versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

`mcpAuth` in both adapters takes new optional `resourceUrl` and `requiredScopes` options. A token without `requiredScopes` gets a `403` with an `insufficient_scope` challenge, and `resourceUrl` sets the challenge's `resource_metadata` instead of deriving it from the request.

The `WWW-Authenticate` challenge from both adapters now quotes `resource_metadata`, which was invalid unquoted, and a rejected token now gets the challenge with `error="invalid_token"` instead of no header.

In the Express adapter, `mcpAuth` is now synchronous, so it works with or without `await`. A malformed `Authorization` header now gets a `401` challenge: before, a bare `Bearer` header returned a `500`, or hung the request with an unhandled rejection under `mcpAuthClerk`, and any other scheme was treated as a bearer token. `resource_metadata` no longer includes the request's query string.

In the Next.js adapter, `protectedResourceHandler` and `protectedResourceHandlerClerk` now set `resource` from the route path, so `/.well-known/oauth-protected-resource/mcp` describes `<origin>/mcp` instead of the bare origin.
