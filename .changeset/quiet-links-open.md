---
'@clerk/mcp-tools': minor
---

Add `@clerk/mcp-tools/create-browser-session`, whose `createBrowserSessionTool` gives agents a one-time link that opens your app signed in as the user. The tool sets the `scopeChallenge` registration option of MCP SDK 2.1 or later, so on those versions a token without its `requiredScopes` gets the step-up challenge. On earlier SDK versions the tool still works, and an under-scoped token gets the tool's own missing-scope error.

`isClerkAuthInfo` from `@clerk/mcp-tools/server` is now a type guard for the new exported `ClerkAuthInfo` type, and it also requires a non-empty `extra.userId`.

`submitFeedbackTool` now also checks that `fetch` is a function when it is created, so a bad value fails at startup instead of on the first call.

`submitFeedback` now throws a `Clerk error:` message for a blank `secretKey` before it sends a request, as `submitFeedbackTool` already did. `verifyClerkToken` now returns the `ClerkAuthInfo` type.

`@clerk/mcp-tools/server` and `@clerk/mcp-tools/next` now export `scopeChallengeFor` (and the `ScopeChallengeHandler` type). It builds the `scopeChallenge` registration option of MCP SDK 2.1 or later from the scopes a tool needs, so any tool can send the step-up challenge.
