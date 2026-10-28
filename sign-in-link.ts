import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

import { isClerkAuthInfo } from './server';
import { isAllowedApiUrl } from './url';

const DEFAULT_API_URL = 'https://api.clerk.com';

// Well under MCP clients' own request timeouts.
const REQUEST_TIMEOUT_MS = 10_000;

// Lifetime of the one-time link the Backend API returns.
const LINK_LIFETIME_SECONDS = 3600;

export const CREATE_SIGN_IN_LINK_TOOL_NAME = 'create_sign_in_link';

export const DEFAULT_SIGN_IN_LINK_TASK_DESCRIPTION =
  'Signed-in browser session requested through MCP';

export type SignInLinkOptions = {
  /** Secret key of the Clerk instance the user belongs to. */
  secretKey: string;
  /** Default landing page for the link. HTTPS, or HTTP on loopback. */
  destinationUrl: string;
  /** Name recorded for the agent. Defaults to `mcp:<client id>`, or `mcp`, when unset or blank. */
  agentName?: string;
  /** Lifetime of the browser session the link starts. Must be a positive integer. */
  sessionMaxDurationInSeconds?: number;
  /** Origin of the Clerk Backend API. Defaults to https://api.clerk.com. */
  apiUrl?: string;
  /** Scopes the token must carry. Missing scopes refuse the request before any API call. Default: none. */
  requiredScopes?: readonly string[];
  fetch?: typeof fetch;
  /** Clock used to compute `expires_at`. */
  now?: () => Date;
};

export type SignInLinkRequest = {
  /** Auth info produced by `verifyClerkToken`. The signed-in user is taken from here only. */
  authInfo: AuthInfo | undefined;
  /** Path (with optional query and hash) on the destination origin to land on. */
  path?: string;
  /** Short description of why the link is needed. */
  taskDescription?: string;
};

export type SignInLink = {
  /** One-time link. Treat it as a credential: never log it. */
  url: string;
  agent_task_id: string;
  expires_at: string;
  redirect_url: string;
};

export type SignInLinkErrorCode =
  | 'not_authenticated'
  | 'invalid_path'
  | 'rejected'
  | 'insufficient_scope'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable';

export class SignInLinkError extends Error {
  /** True when the failed request named a `path`. */
  readonly pathGiven: boolean;

  constructor(
    readonly code: SignInLinkErrorCode,
    message: string,
    { pathGiven = false }: { pathGiven?: boolean } = {},
  ) {
    super(message);
    this.name = 'SignInLinkError';
    this.pathGiven = pathGiven;
  }
}

/** Throws a `Clerk error:` message when the options cannot work. Call it once at construction. */
export function validateSignInLinkOptions(options: SignInLinkOptions): void {
  if (!options.secretKey?.trim()) {
    throw new Error('Clerk error: createSignInLink requires the secretKey of a Clerk instance');
  }
  if (options.apiUrl !== undefined && !isAllowedApiUrl(options.apiUrl)) {
    throw new Error('Clerk error: createSignInLink apiUrl must use HTTPS or loopback HTTP');
  }
  if (!isAllowedApiUrl(options.destinationUrl)) {
    throw new Error(
      'Clerk error: createSignInLink destinationUrl must be a URL that uses HTTPS or loopback HTTP',
    );
  }
  if (options.requiredScopes?.some((scope) => typeof scope !== 'string' || !scope.trim())) {
    throw new Error('Clerk error: createSignInLink requiredScopes must be non-empty strings');
  }
  const seconds = options.sessionMaxDurationInSeconds;
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds <= 0)) {
    throw new Error(
      'Clerk error: createSignInLink sessionMaxDurationInSeconds must be a positive integer',
    );
  }
}

/**
 * Resolves the agent's `path` against the origin of `destinationUrl`. The agent path replaces the
 * destination's path and query. Anything that could leave the destination origin is refused.
 */
export function resolveRedirectUrl(destinationUrl: string, path: string | undefined): string {
  if (path === undefined) {
    return destinationUrl;
  }
  const invalid = () =>
    new SignInLinkError('invalid_path', 'path must start with a single "/" and stay on the app');
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    throw invalid();
  }
  const destination = new URL(destinationUrl);
  let resolved: URL;
  try {
    resolved = new URL(path, destination.origin);
  } catch {
    throw invalid();
  }
  if (resolved.origin !== destination.origin || resolved.pathname.startsWith('//')) {
    throw invalid();
  }
  return resolved.href;
}

function errorForStatus(status: number, pathGiven: boolean): SignInLinkError {
  if (status === 401 || status === 403) {
    return new SignInLinkError('unauthorized', 'Clerk rejected the server credentials');
  }
  if (status === 429) {
    return new SignInLinkError('rate_limited', 'Too many sign-in links were requested');
  }
  if (status >= 400 && status < 500) {
    return new SignInLinkError('rejected', 'Clerk rejected the sign-in link request', {
      pathGiven,
    });
  }
  return new SignInLinkError('unavailable', 'Clerk could not create a sign-in link');
}

/**
 * Creates a one-time link that opens the app in a browser as the user who authorized the MCP request.
 * The user comes from `authInfo` (set by `verifyClerkToken`), never from tool input.
 */
export async function createSignInLink(
  options: SignInLinkOptions,
  request: SignInLinkRequest,
): Promise<SignInLink> {
  validateSignInLinkOptions(options);
  const {
    secretKey,
    destinationUrl,
    apiUrl = DEFAULT_API_URL,
    fetch: fetchImpl = fetch,
    now = () => new Date(),
  } = options;
  const { authInfo } = request;

  const userId = authInfo?.extra?.userId;
  if (!isClerkAuthInfo(authInfo) || typeof userId !== 'string' || !userId) {
    throw new SignInLinkError('not_authenticated', 'A Clerk-verified signed-in user is required');
  }

  const missingScopes = (options.requiredScopes ?? []).filter(
    (scope) => !authInfo?.scopes?.includes(scope),
  );
  if (missingScopes.length > 0) {
    throw new SignInLinkError(
      'insufficient_scope',
      `The token is missing required scopes: ${missingScopes.join(', ')}`,
    );
  }

  const redirectUrl = resolveRedirectUrl(destinationUrl, request.path);
  const body = {
    on_behalf_of: { user_id: userId },
    permissions: '*',
    agent_name:
      options.agentName?.trim() || (authInfo?.clientId ? `mcp:${authInfo.clientId}` : 'mcp'),
    task_description: request.taskDescription?.trim() || DEFAULT_SIGN_IN_LINK_TASK_DESCRIPTION,
    redirect_url: redirectUrl,
    ...(options.sessionMaxDurationInSeconds !== undefined && {
      session_max_duration_in_seconds: options.sessionMaxDurationInSeconds,
    }),
  };

  // Error messages never carry the response body, the secret key, or the link.
  let response: Response;
  try {
    response = await fetchImpl(new URL('/v1/agents/tasks', apiUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SignInLinkError('unavailable', 'Clerk could not be reached');
  }
  if (!response.ok) {
    // Release the connection without reading the body; the body is never used.
    await response.body?.cancel().catch(() => {});
    throw errorForStatus(response.status, request.path !== undefined);
  }

  const result: unknown = await response.json().catch(() => undefined);
  if (
    typeof result !== 'object' ||
    result === null ||
    !('url' in result) ||
    typeof result.url !== 'string' ||
    !('agent_task_id' in result) ||
    typeof result.agent_task_id !== 'string'
  ) {
    throw new SignInLinkError('unavailable', 'Clerk returned an unreadable response');
  }

  return {
    url: result.url,
    agent_task_id: result.agent_task_id,
    expires_at: new Date(now().getTime() + LINK_LIFETIME_SECONDS * 1000).toISOString(),
    redirect_url: redirectUrl,
  };
}

export const SIGN_IN_LINK_DESCRIPTION = [
  'Get a one-time link that opens this app in a browser already signed in as the current user.',
  'Call it when a browser task reaches a sign-in page for this app, then open the returned URL in the browser.',
  'The link is single use and expires in about 1 hour, so create it right before you open it.',
  'Do not share the URL or print it to the user unless they ask for it.',
].join(' ');

export const signInLinkInputSchema = {
  path: z
    .string()
    .max(2048)
    .optional()
    .describe(
      "Page to open after sign-in, as an absolute path such as /settings. Omit for the app's default page.",
    ),
  task_description: z
    .string()
    .max(500)
    .optional()
    .describe('Short description of why you need the browser session.'),
};

const signInLinkOutputSchema = {
  url: z.string(),
  agent_task_id: z.string(),
  expires_at: z.string(),
  redirect_url: z.string(),
};

export type SignInLinkToolOptions = SignInLinkOptions;

type SignInLinkToolCallback = ToolCallback<typeof signInLinkInputSchema>;

/** Arguments for `McpServer.registerTool`. */
export type SignInLinkTool = [
  name: typeof CREATE_SIGN_IN_LINK_TOOL_NAME,
  config: {
    title: string;
    description: string;
    inputSchema: typeof signInLinkInputSchema;
    outputSchema: typeof signInLinkOutputSchema;
    annotations: ToolAnnotations;
  },
  callback: SignInLinkToolCallback,
];

function toolError(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

/**
 * Tells the agent what to do next after a failed `createSignInLink`. The message never includes the link,
 * the response body, or the secret key.
 */
export function signInLinkErrorMessage(error: SignInLinkError): string {
  switch (error.code) {
    case 'not_authenticated':
      return 'No signed-in user is available for this request. Ask the user to reconnect this MCP server and sign in, then try again.';
    case 'invalid_path':
      return 'The path is not allowed. Use an absolute path such as /settings, or omit it to open the default page.';
    case 'insufficient_scope':
      return `${error.message}. Ask the user to reconnect this MCP server and approve those scopes, then try again.`;
    case 'rejected':
      return error.pathGiven
        ? 'Clerk rejected the request. Try again with a different path, or omit the path to open the default page.'
        : 'Clerk rejected the request. Do not retry. Tell the user the sign-in link could not be created.';
    case 'unauthorized':
      return 'The server is not authorized to create sign-in links. Tell the user the server owner must check the Clerk configuration. Do not retry.';
    case 'rate_limited':
      return 'Too many sign-in links were requested. Wait a while before you try again.';
    case 'unavailable':
      return 'Clerk could not create a sign-in link right now. Try again in a moment.';
    default: {
      const _exhaustive: never = error.code;
      throw new Error(`Unhandled sign-in link error: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Builds a `create_sign_in_link` tool that gives an agent a one-time link to open the app signed in as the
 * user who authorized the MCP request. Register it with `server.registerTool(...signInLinkTool(options))`.
 * Throws at construction when the options cannot work.
 */
export function signInLinkTool(options: SignInLinkToolOptions): SignInLinkTool {
  validateSignInLinkOptions(options);

  const callback: SignInLinkToolCallback = async (input, extra) => {
    try {
      const link = await createSignInLink(options, {
        authInfo: extra.authInfo,
        path: input.path,
        taskDescription: input.task_description,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Open this single use link in the browser to sign in: ${link.url}\nIt expires at ${link.expires_at}.`,
          },
        ],
        structuredContent: link,
      };
    } catch (error) {
      return toolError(
        error instanceof SignInLinkError
          ? signInLinkErrorMessage(error)
          : 'The sign-in link could not be created. Continue without it, or ask the user to sign in.',
      );
    }
  };

  return [
    CREATE_SIGN_IN_LINK_TOOL_NAME,
    {
      title: 'Get a signed-in browser link',
      description: SIGN_IN_LINK_DESCRIPTION,
      inputSchema: signInLinkInputSchema,
      outputSchema: signInLinkOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    callback,
  ];
}
