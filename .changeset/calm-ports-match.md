---
'@clerk/mcp-tools': minor
---

Add `createMcpAuthClerk({ audience, resourceMetadataUrl? })` to `@clerk/mcp-tools/express` and `@clerk/mcp-tools/hono`. It verifies the OAuth access token like `mcpAuthClerk` and also refuses a token that was not issued for `audience` with `401`. It throws a `Clerk error:` message when `audience` is missing or empty. `mcpAuthClerk` is unchanged and does not check the audience. For a JWT access token the factory also checks `aud` itself after Clerk verified the token, so a Clerk SDK that ignores `audience` still cannot accept a token for another resource. Opaque tokens rely on Clerk's own check.

The auth info that `createMcpAuthClerk` stores now carries `resourceMetadataUrl`, by default the protected resource metadata URL that the `401` response advertises, so that `@modelcontextprotocol/server` 2.1 or later can put `resource_metadata` in its step-up challenge. Pass `resourceMetadataUrl` to replace it. The `ClerkAuthInfo` type from `@clerk/mcp-tools/server` gains that optional field. The README shows `createBrowserSessionTool` with step-up on Express and Hono, behind the `@modelcontextprotocol/node` and `@modelcontextprotocol/hono` adapters.

`createBrowserSessionTool` now logs one `Clerk warning:` per tool when a token with missing scopes reaches the tool on `@modelcontextprotocol/server` 2.0, because that version cannot send the step-up challenge. Upgrade to 2.1 or later.
