// Internal helpers for the tools this package builds. Not part of the package exports.
import type { AuthInfo, ToolAnnotations } from './mcp-types';
import type { z } from 'zod/v4';

export const OPEN_WORLD_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * The parts of the callback's second argument the tools read. The MCP SDK v1 passes `authInfo`
 * (`RequestHandlerExtra`) and v2 passes `http.authInfo` (`ServerContext`), so both are assignable to it.
 */
export type McpToolExtra = {
  authInfo?: AuthInfo;
  http?: { authInfo?: AuthInfo };
};

/** The auth info of a tool call, on MCP SDK v1 and v2. */
export function toolAuthInfo(extra: McpToolExtra): AuthInfo | undefined {
  return extra.http?.authInfo ?? extra.authInfo;
}

/** Whether a tool call has the MCP SDK 2.x shape: `extra.http`, which the 1.x SDK never sets. */
export function isSdkV2Extra(extra: McpToolExtra): boolean {
  return extra.http !== undefined;
}

/** The MCP SDK 2.1+ `scopeChallenge` registration option: the complete scope set to challenge for, or `undefined`. */
export type ScopeChallengeHandler = (context: {
  authInfo?: AuthInfo;
}) => { scopes: readonly [string, ...string[]] } | undefined;

/** Arguments for `McpServer.registerTool`, on MCP SDK v1 and v2. */
export type McpToolTuple<
  Name extends string,
  InputSchema extends z.ZodRawShape,
  OutputSchema extends z.ZodRawShape,
  Extra extends McpToolExtra = McpToolExtra,
> = [
  name: Name,
  config: {
    title: string;
    description: string;
    inputSchema: InputSchema;
    outputSchema: OutputSchema;
    annotations: ToolAnnotations;
    /** The MCP SDK 2.1+ step-up check, run before the callback. SDK versions before 2.1 ignore it. */
    scopeChallenge?: ScopeChallengeHandler;
  },
  callback: (
    input: z.infer<z.ZodObject<InputSchema>>,
    extra: Extra,
  ) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent?: z.infer<z.ZodObject<OutputSchema>>;
    isError?: boolean;
  }>,
];

export function toolResult<T extends Record<string, unknown>>(text: string, structuredContent: T) {
  return { content: [{ type: 'text' as const, text }], structuredContent };
}

export function toolError(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}
