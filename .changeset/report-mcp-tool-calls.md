---
'@clerk/mcp-tools': minor
---

Add `clerkInstrumentHandler` and `clerkInstrumentServer`, which report MCP tool calls to Clerk's Backend API for MCP analytics and the audit log.

- `clerkInstrumentHandler(handler, options)` from `@clerk/mcp-tools/express`, `/hono`, and `/next` authenticates each MCP request as `mcpAuth` and `withClerkMcpAuth` do, then serves it with the handler `createMcpHandler` from `@modelcontextprotocol/server` returns, the route handler from `mcp-handler`, or a handler of your own. Express serves an MCP SDK 2.x handler through `toNodeHandler` from `@modelcontextprotocol/node`, a new optional peer dependency.
- `clerkInstrumentServer(server)`, called where each MCP server is created, lets the handler see its tool calls. Tools registered after it also report their handler's time, and a handler that throws is reported with the error code `thrown:<name>`, told apart from a returned `isError` result.
- The new `reporting` option turns reporting on, off by default. Its options object turns off the IP address, `User-Agent`, or Clerk identity, picks which tools are reported, and names the server. Reports go to `POST /v1/mcp_events` as `tool_call` events in batches, after the response, and never send tool arguments, results, or error messages.
- `mcpAuth`, `streamableHttpHandler`, and `withClerkMcpAuth` are deprecated, and refuse `reporting` with a `Clerk error:`.
