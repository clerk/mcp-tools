# @clerk/mcp-tools

## 0.9.0

### Minor Changes

- 4b0a634: Add `@clerk/mcp-tools/create-browser-session`, whose `createBrowserSessionTool` gives agents a one-time link that opens your app signed in as the user. The tool sets the `scopeChallenge` registration option of MCP SDK 2.1 or later, so on those versions a token without its `requiredScopes` gets the step-up challenge. On earlier SDK versions the tool still works, and an under-scoped token gets the tool's own missing-scope error.

  `isClerkAuthInfo` from `@clerk/mcp-tools/server` is now a type guard for the new exported `ClerkAuthInfo` type, and it also requires a non-empty `extra.userId`.

  `submitFeedbackTool` now also checks that `fetch` is a function when it is created, so a bad value fails at startup instead of on the first call. `submitFeedback` now checks that `fetch` is a function too, and its `apiUrl` error text now reads `Clerk error: submitFeedback apiUrl must use HTTPS or loopback HTTP`.

  `submitFeedback` now throws a `Clerk error:` message for a blank `secretKey` before it sends a request, as `submitFeedbackTool` already did. `verifyClerkToken` now returns the `ClerkAuthInfo` type.

  `createBrowserSessionTool` and `createBrowserSession` take a new `restricted` option, `true` by default, that limits the session the link starts. Clerk's Frontend API refuses these writes from that session: touch, switching the active session or organization, sign-out, writes to the user's own profile and organizations, reverification, and OAuth consent and approval. The one exception is refreshing its own session token. Your app's own backend still sees an ordinary signed-in session. Clerk must confirm the restriction in its response: otherwise no link is returned and the error code is the new `restricted_not_applied`. When Clerk does not confirm it, the tool also revokes the new session link on a best-effort basis. Pass `restricted: false` for an ordinary session.

  On MCP SDK 2.0, where a missing scope reaches the tool instead of the step-up challenge, the tool now logs one `Clerk warning:` per process that says to upgrade `@modelcontextprotocol/server` to 2.1 or later.

  `createBrowserSession` takes a new optional `organizationId` in its request, which sets the organization the session starts in. With `restricted`, it is also the only organization the session can use. When it is set, Clerk must confirm that organization in its response: otherwise no link is returned, the new session link is revoked on a best-effort basis, and the error code is `restricted_not_applied`. When the user does not belong to the organization, or the instance requires one and none applies, the error code is the new `organization_rejected`.

- 30ab894: `@clerk/mcp-tools/server` and `@clerk/mcp-tools/next` now export `requireAdditionalScopes`. It builds the `scopeChallenge` registration option of MCP SDK 2.1 or later from the scopes a tool needs, passed as separate arguments (`requireAdditionalScopes('projects:read', 'projects:write')`), so any tool can send the step-up challenge.

## 0.8.0

### Minor Changes

- 4bc331e: `submitFeedbackTool` now works on servers built with the MCP SDK v2 (`@modelcontextprotocol/server`), as well as v1. On v2 the agent name and the default server name are attached to each report, as are the user and OAuth client ids when the request was authenticated with `verifyClerkToken`, and the tool registers without a type cast. Servers on SDK v1 are unaffected.

## 0.7.0

### Minor Changes

- a4b939d: Add `@clerk/mcp-tools/feedback`, whose `submitFeedbackTool()` builds a `submit_feedback` tool (`server.registerTool(...submitFeedbackTool({ secretKey }))`) that stores agent feedback on your Clerk instance so you can review it in the Clerk Dashboard.

  `verifyClerkToken` now marks its result with `extra.verifiedBy: 'clerk'`, and the new `isClerkAuthInfo()` from `@clerk/mcp-tools/server` checks for it.

### Patch Changes

- d79b872: Fix a denial-of-service bug in the Express `streamableHttpHandler`: connecting a new transport to the same `McpServer` on every request caused the MCP SDK to throw "Already connected to a transport" on every request after the first, permanently breaking the endpoint. The handler now accepts a server factory (matching the Hono adapter) so a fresh server is created per request, closes the transport when the response completes, and still supports passing a plain `McpServer` instance for backwards compatibility.
