// Why `streamableHttpHandler` is deprecated. Each adapter's JSDoc repeats it in the function's `@deprecated` tag, so
// editors and agents reading the declarations see the same text the warning logs.
const DEPRECATION =
  "`streamableHttpHandler` is the MCP SDK 1.x path (`@modelcontextprotocol/sdk`): it can't serve protocol revision 2026-07-28 or `server/discover`, so clients fall back to an older revision. Build the server with MCP SDK 2.x (`@modelcontextprotocol/server`) and serve the handler `createMcpHandler` returns with `clerkInstrumentHandler(handler, options)`. `streamableHttpHandler` will be removed in `@clerk/mcp-tools` 2.0.";

// Module-level, so an app that creates handlers in several places, or with both adapters, warns once per process
let warned = false;

/**
 * Logs the `streamableHttpHandler` deprecation with `console.warn` the first time any adapter creates the handler.
 */
export function warnStreamableHttpHandlerDeprecated() {
  if (warned) return;
  warned = true;
  console.warn(`Clerk warning: \`streamableHttpHandler\` is deprecated. ${DEPRECATION}`);
}
