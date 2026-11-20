---
'@clerk/mcp-tools': minor
---

`createBrowserSessionTool`'s `organizationId` function can now tell the agent why it could not find the organization. Throw the new `OrganizationLookupError` from `@clerk/mcp-tools/tools` with a stable code and the text the agent reads, such as `new OrganizationLookupError('token_exchange_rejected', 'Ask the user to reconnect this MCP server, then try again.')`, for a failure the user can fix by reconnecting. The result keeps `_meta[ERROR_CODE_META_KEY]` as `organization_lookup_failed` and adds the code as `_meta[ERROR_CAUSE_META_KEY]` (`'clerk.com/error_cause'`, also exported) and to the log line, so a wrapper can log it. Any other error the function throws still gets the generic text, and the error's own message still never reaches the agent or the log.
