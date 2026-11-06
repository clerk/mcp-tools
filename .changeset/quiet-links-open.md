---
'@clerk/mcp-tools': minor
---

Add `@clerk/mcp-tools/create-browser-session`, whose `createBrowserSessionTool` gives agents a one-time link that opens your app signed in as the user. The tool sets the `scopeChallenge` registration option of MCP SDK 2.1 or later, so on those versions a token without its `requiredScopes` gets the step-up challenge. On earlier SDK versions the tool still works, and an under-scoped token gets the tool's own missing-scope error.

`isClerkAuthInfo` from `@clerk/mcp-tools/server` is now a type guard for the new exported `ClerkAuthInfo` type, and it also requires a non-empty `extra.userId`.

`submitFeedbackTool` now also checks that `fetch` is a function when it is created, so a bad value fails at startup instead of on the first call. `submitFeedback` now checks that `fetch` is a function too, and its `apiUrl` error text now reads `Clerk error: submitFeedback apiUrl must use HTTPS or loopback HTTP`.

`submitFeedback` now throws a `Clerk error:` message for a blank `secretKey` before it sends a request, as `submitFeedbackTool` already did. `verifyClerkToken` now returns the `ClerkAuthInfo` type.

`createBrowserSessionTool` and `createBrowserSession` take a new `restricted` option, `true` by default, that limits the session the link starts. Clerk's Frontend API refuses these writes from that session: touch, switching the active session or organization, sign-out, writes to the user's own profile and organizations, reverification, and OAuth consent and approval. The one exception is refreshing its own session token. Your app's own backend still sees an ordinary signed-in session. Clerk must confirm the restriction in its response: otherwise no link is returned and the error code is the new `restricted_not_applied`. When Clerk does not confirm it, the tool also revokes the new session link on a best-effort basis. Pass `restricted: false` for an ordinary session.

On MCP SDK 2.0, where a missing scope reaches the tool instead of the step-up challenge, the tool now logs one `Clerk warning:` per process that says to upgrade `@modelcontextprotocol/server` to 2.1 or later.
