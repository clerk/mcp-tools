---
'@clerk/mcp-tools': minor
---

**Breaking:** in `@clerk/mcp-tools/express` and `@clerk/mcp-tools/hono`, `mcpAuthClerk` is now a factory that takes `{ resourceUrl, requiredScopes }`. It verifies OAuth access tokens with Clerk and checks that their audience is `resourceUrl`. The old middleware did not check the audience, so a token issued for another resource passed. Replace `app.post('/mcp', mcpAuthClerk, handler)` with `app.post('/mcp', mcpAuthClerk({ resourceUrl: 'https://mcp.example.com/mcp' }), handler)`, using the exact URL clients use for the endpoint. The peer dependency ranges now start at `@clerk/express` 2.1.70 and `@clerk/hono` 0.1.80, because on earlier versions a JWT access token without an `aud` claim and an opaque OAuth access token both pass the audience check.

`mcpAuth` in both adapters takes new optional `resourceUrl` and `requiredScopes` options. A token without `requiredScopes` gets a `403` with an `insufficient_scope` challenge, and `resourceUrl` sets the challenge's `resource_metadata` instead of deriving it from the request.

The `WWW-Authenticate` challenge from both adapters now quotes `resource_metadata`, which was invalid unquoted, and a rejected token now gets the challenge with `error="invalid_token"` instead of no header.

In the Express adapter, `mcpAuth` is now synchronous, so it works with or without `await`. A malformed `Authorization` header now gets a `401` challenge: before, a bare `Bearer` header returned a `500`, or hung the request with an unhandled rejection under `mcpAuthClerk`, and any other scheme was treated as a bearer token. `resource_metadata` no longer includes the request's query string.

In the Next.js adapter, `protectedResourceHandler` and `protectedResourceHandlerClerk` now set `resource` from the route path, so `/.well-known/oauth-protected-resource/mcp` describes `<origin>/mcp` instead of the bare origin.
