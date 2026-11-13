---
'@clerk/mcp-tools': patch
---

`McpAuthError` now keeps the `cause`'s `status` only when it is an integer from `500` to `599`. With a fractional status such as `503.5`, Express's `res.status()` threw, so `mcpAuth` in `./express` answered with Express's HTML error page instead of the JSON `{"error":"server_error"}`, and `mcpAuth` in `./hono` answered with the truncated `503`. Both now answer with the JSON and a `500`.
