// Internal helpers shared by the Backend API tools. Not part of the package exports.
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_API_URL = 'https://api.clerk.com';

// Well under MCP clients' own request timeouts, so a stalled API still gets the agent a useful message.
const REQUEST_TIMEOUT_MS = 10_000;

export type BackendApiOptions = {
  secretKey: string;
  /** Origin of the Clerk Backend API. Defaults to https://api.clerk.com. */
  apiUrl?: string;
  fetch?: typeof fetch;
};

export function isAllowedApiUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/** Throws a `Clerk error:` message, prefixed with `label`, when the secret key or API URL cannot work. */
export function validateBackendApiOptions(label: string, { secretKey, apiUrl }: BackendApiOptions) {
  if (!secretKey?.trim()) {
    throw new Error(`Clerk error: ${label} requires the secretKey of a Clerk instance`);
  }
  if (apiUrl !== undefined && !isAllowedApiUrl(apiUrl)) {
    throw new Error(`Clerk error: ${label} apiUrl must use HTTPS or loopback HTTP`);
  }
}

/** POSTs `body` as JSON with the secret key. Refuses to send the key to an API URL that is not allowed. */
export async function postBackendApi(
  path: string,
  body: unknown,
  { secretKey, apiUrl = DEFAULT_API_URL, fetch: fetchImpl = fetch }: BackendApiOptions,
): Promise<Response> {
  if (!isAllowedApiUrl(apiUrl)) {
    throw new Error('Clerk error: apiUrl must use HTTPS or loopback HTTP');
  }
  return fetchImpl(new URL(path, apiUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export const OPEN_WORLD_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Arguments for `McpServer.registerTool`. */
export type McpToolTuple<
  Name extends string,
  InputSchema extends ZodRawShapeCompat,
  OutputSchema extends ZodRawShapeCompat,
> = [
  name: Name,
  config: {
    title: string;
    description: string;
    inputSchema: InputSchema;
    outputSchema: OutputSchema;
    annotations: ToolAnnotations;
  },
  callback: ToolCallback<InputSchema>,
];
