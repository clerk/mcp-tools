---
'@clerk/mcp-tools': minor
---

`streamableHttpHandler` in `./express` and `./hono` now answers any request that isn't a `POST` with a `405`, `Allow: POST`, and the JSON-RPC `Method not allowed.` error, the same answer MCP SDK 2's stateless serving gives. It serves each request on a new stateless transport, so a `GET` had no session to stream on, and the SDK 1 transport opened a stream that nothing wrote to. The examples now mount the endpoint with `app.all('/mcp', ...)`, so a `GET` without a token reaches `mcpAuth` and gets the `401`, or the `405` when `publicAccess` opens the handshake, rather than the framework's `404`. That `405` from `mcpAuth` and `withMcpAuth` now carries the same JSON-RPC body instead of `{"error":"method_not_allowed"}`, so a `GET` gets one answer whether or not it carries a token.
