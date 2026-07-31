---
'@clerk/mcp-tools': minor
---

Migrate from the monolithic `@modelcontextprotocol/sdk` 1.x to the stable v2 packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/node` 2.0.0).

**Breaking changes:**

- The Express `streamableHttpHandler` now takes a server factory (`() => McpServer`) instead of a shared `McpServer` instance — v2 transports are constructed per-request and stateless. The Hono adapter already used a factory; its signature is unchanged.
- `AuthInfo`, `McpServer`, and related types are now sourced from `@modelcontextprotocol/server` / `@modelcontextprotocol/client` instead of `@modelcontextprotocol/sdk`.

**New:**

- `streamableHttpHandler` for Next.js (`@clerk/mcp-tools/next`) with an optional `verifyToken` hook — no more dependency on the external `mcp-adapter` package.
- Servers built with any adapter answer both the modern `server/discover` handshake (protocol revision 2026-07-28) and the legacy `initialize` handshake via the v2 SDK's built-in stateless legacy fallback.

The OAuth session stores (fs/redis/postgres/sqlite) are unchanged: they hold application-level OAuth state (PKCE verifiers, tokens), not protocol sessions.
