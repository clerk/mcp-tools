---
'@clerk/mcp-tools': minor
---

The `403` `insufficient_scope` challenge from `mcpAuth` in `./express` and `./hono` and `withMcpAuth` in `./next` now lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry, each once. It used to list only the missing `requiredScopes`, so a client that also lacked a tool's `requireAdditionalScopes` scopes reauthorized for the `403` and then again for the tool. List each tool's scopes in `challengeScopes` to have the client reauthorize once, as MCP 2026-07-28 asks of scope challenges. The `403` still fires only when a `requiredScopes` entry is missing: a token that lacks only `challengeScopes` is let through, as before.
