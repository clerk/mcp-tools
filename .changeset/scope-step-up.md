---
'@clerk/mcp-tools': minor
---

Add `scopeChallenge` and the `ToolScopes` type to `@clerk/mcp-tools/server` (also re-exported from `@clerk/mcp-tools/next`). `scopeChallenge` returns the MCP step-up response, a `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`, when a tool call needs OAuth scopes the token lacks. `ToolScopes` is a plain object of tool name to scopes, for example `{ list_projects: ['projects:read'] }`.

The Express and Hono `mcpAuth` helpers accept the same map as an option, `mcpAuth(verifyToken, { toolScopes })`. The Express helper reads `req.body`, so register `express.json()` before it; a `POST` with a body it did not parse gets a `415`.

The middleware that the Express `mcpAuth` resolves to is now typed as returning `void`. Its runtime behavior is unchanged.
