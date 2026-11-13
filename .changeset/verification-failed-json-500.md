---
'@clerk/mcp-tools': minor
---

When `verifyToken` throws or Clerk cannot verify a token, for example with an invalid secret key, `mcpAuth` in `./express` and `./hono` now answers with a JSON `{"error":"server_error"}` and the `McpAuthError`'s `status`, or `500`, instead of the framework's default error page. Express's default page is HTML with the stack trace outside production. Express sends the JSON first and then passes the `McpAuthError` to your error middleware, where `res.headersSent` is `true`, so log it there without answering again. Hono throws it to `onError` as before; Hono's default handler answers with the JSON and logs it with `console.error`. In `./next`, `withMcpAuth` still throws, and Next.js answers with an empty `500`; the README shows how to log the error from `onRequestError` in `instrumentation.ts`.
