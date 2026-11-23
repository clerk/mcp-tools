---
'@clerk/mcp-tools': minor
---

Compact tool schemas in `tools/list` by default, and add `measureToolList`.

`streamableHttpHandler` (Express, Hono) and `withClerkMcpAuth` (Next.js) now leave out a root `$schema` naming JSON Schema 2020-12, which MCP assumes when `$schema` is absent, and empty `additionalProperties` from the tool schemas of every `tools/list` result. What each schema accepts is unchanged; other `$schema` values (such as MCP SDK 1.x's draft-07), `additionalProperties: false`, and empty `additionalProperties` in schemas that use `unevaluatedProperties` are kept. To list schemas exactly as the MCP SDK writes them, pass `{ compactSchemas: false }` as the third argument of `streamableHttpHandler`, or `compactSchemas: false` in the `withClerkMcpAuth` options.

New in `@clerk/mcp-tools/server` (and every adapter): `compactToolSchemas(server)` applies the same compaction to a server you serve another way, `compactJsonSchema(schema)` compacts one schema, and `measureToolList(serverOrToolsListResult)` reports each tool's size in characters and an approximate token count, for tool-list budgets in tests.
