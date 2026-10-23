# @clerk/mcp-tools

## 0.7.0

### Minor Changes

- a4b939d: Add `@clerk/mcp-tools/feedback`, whose `submitFeedbackTool()` builds a `submit_feedback` tool (`server.registerTool(...submitFeedbackTool({ secretKey }))`) that stores agent feedback on your Clerk instance so you can review it in the Clerk Dashboard.

  `verifyClerkToken` now marks its result with `extra.verifiedBy: 'clerk'`, and the new `isClerkAuthInfo()` from `@clerk/mcp-tools/server` checks for it.

### Patch Changes

- d79b872: Fix a denial-of-service bug in the Express `streamableHttpHandler`: connecting a new transport to the same `McpServer` on every request caused the MCP SDK to throw "Already connected to a transport" on every request after the first, permanently breaking the endpoint. The handler now accepts a server factory (matching the Hono adapter) so a fresh server is created per request, closes the transport when the response completes, and still supports passing a plain `McpServer` instance for backwards compatibility.
