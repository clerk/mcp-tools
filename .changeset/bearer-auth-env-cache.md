---
'@clerk/mcp-tools': minor
---

Move reading Clerk keys from a Workers `env`, and the cache of Clerk clients built from them, out of the Hono adapter into the shared bearer-auth core, so the Hono `mcpAuth` and the new `@clerk/mcp-tools/fetch` entry build and reuse their default Clerk client the same way. The Hono adapter's behaviour is unchanged: it still reads its keys from `env(c)`, keeps one client per set of keys, and throws the same errors.
