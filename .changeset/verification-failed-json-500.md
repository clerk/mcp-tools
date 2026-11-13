---
'@clerk/mcp-tools': minor
---

When `verifyToken` throws or Clerk cannot verify a token, for example with an invalid secret key, `mcpAuth` in `./express` and `./hono` now answers with a JSON `{"error":"server_error"}` and the `McpAuthError`'s `status` (Clerk's `429` or `5xx`), or `500`, instead of the framework's default error page. Express's default page is HTML with the stack trace outside production. Express logs the `McpAuthError` with `console.error` and doesn't pass it to error middleware, whose default handler would reset a connection that is still uploading its body. Hono throws it to `onError` as before; Hono's default handler answers with the JSON and logs it with `console.error`. In `./next`, `withMcpAuth` still throws, and Next.js answers with an empty `500`; the README shows how to log the error from `onRequestError` in `instrumentation.ts`.
