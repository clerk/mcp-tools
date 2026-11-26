---
'@clerk/mcp-tools': minor
---

Add `@clerk/mcp-tools/fetch`, an entry for plain `fetch` Workers such as Cloudflare Workers. Its `withClerkMcpAuth(handler, options)` wraps any `fetch`-style MCP handler with Clerk auth and returns a `(request, env, ctx)` function: it answers requests without a valid token with the `401` challenge, serves the protected resource metadata the challenge points to, verifies tokens with the resource URL as their audience, and calls the handler with `{ authInfo, env, ctx }`. Clerk keys are read from a `clerkClient` option or the Worker `env` passed to `fetch`, never `process.env`, and the Clerk client is cached per set of keys. It imports no MCP SDK.
