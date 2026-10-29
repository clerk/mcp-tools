import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';

import {
  type BackendApiOptions,
  isAllowedApiUrl,
  type McpToolTuple,
  OPEN_WORLD_WRITE_ANNOTATIONS,
  postBackendApi,
  validateBackendApiOptions,
} from './backend-api';
import { isClerkAuthInfo } from './server';

export const CREATE_BROWSER_SESSION_TOOL_NAME = 'create_browser_session';

const DEFAULT_TASK_DESCRIPTION = 'Signed-in browser session requested through MCP';

export type SignInLinkOptions = BackendApiOptions & {
  /** Secret key of the Clerk instance the user belongs to. */
  secretKey: string;
  /** Default landing page for the link. HTTPS, or HTTP on loopback. */
  destinationUrl: string;
  /** Name recorded for the agent. Defaults to `mcp:<client id>`, or `mcp`, when unset or blank. */
  agentName?: string;
  /** Lifetime of the browser session the link starts. Must be a positive integer. */
  sessionMaxDurationInSeconds?: number;
  /** Scopes the token must carry. Missing scopes refuse the request before any API call. Pass `[]` for none. */
  requiredScopes: readonly string[];
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
  redirect_url: string;
};

export type SignInLinkErrorCode =
  | 'not_authenticated'
  | 'invalid_path'
  | 'rejected'
  | 'path_rejected'
  | 'insufficient_scope'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable';

export class SignInLinkError extends Error {
  constructor(
    readonly code: SignInLinkErrorCode,
    message: string,
    /** The scopes the token lacks, for `insufficient_scope`. */
    readonly missingScopes: readonly string[] = [],
  ) {
    super(message);
    this.name = 'SignInLinkError';
  }
}

/**
 * Throws a `Clerk error:` message when the options cannot work. `signInLinkTool` and `createSignInLink` call it
 * too; call it at startup to fail fast on a bad configuration.
 */
export function validateSignInLinkOptions(options: SignInLinkOptions): void {
  validateBackendApiOptions('createSignInLink', options);
  if (!isAllowedApiUrl(options.destinationUrl)) {
    throw new Error(
      'Clerk error: createSignInLink destinationUrl must be a URL that uses HTTPS or loopback HTTP',
    );
  }
  if (!Array.isArray(options.requiredScopes)) {
    throw new Error(
      'Clerk error: createSignInLink requiredScopes must be an array of scopes; pass [] to require none',
    );
  }
  if (options.requiredScopes.some((scope) => typeof scope !== 'string' || !scope.trim())) {
    throw new Error('Clerk error: createSignInLink requiredScopes must be non-empty strings');
  }
  const seconds = options.sessionMaxDurationInSeconds;
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds <= 0)) {
    throw new Error(
      'Clerk error: createSignInLink sessionMaxDurationInSeconds must be a positive integer',
    );
  }
}

const INVALID_PATH_MESSAGE = 'path must start with a single "/" and stay on the app';

// Resolves the agent's `path` against the origin of `destinationUrl`. Refuses anything that could leave that origin.
function resolveRedirectUrl(destinationUrl: string, path: string | undefined): string {
  if (path === undefined) {
    return destinationUrl;
  }
  // The origin check below would accept `//app.example.com/x`; a path that names a host is still refused.
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    throw new SignInLinkError('invalid_path', INVALID_PATH_MESSAGE);
  }
  const { origin } = new URL(destinationUrl);
  let resolved: URL;
  try {
    resolved = new URL(path, origin);
  } catch {
    throw new SignInLinkError('invalid_path', INVALID_PATH_MESSAGE);
  }
  if (resolved.origin !== origin || resolved.pathname.startsWith('//')) {
    throw new SignInLinkError('invalid_path', INVALID_PATH_MESSAGE);
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
    return pathGiven
      ? new SignInLinkError('path_rejected', 'Clerk rejected the sign-in link request for the path')
      : new SignInLinkError('rejected', 'Clerk rejected the sign-in link request');
  }
  return new SignInLinkError('unavailable', 'Clerk could not create a sign-in link');
}

const agentTaskResponseSchema = z.object({ url: z.string(), agent_task_id: z.string() });

/**
 * Creates a one-time link that opens the app in a browser as the user who authorized the MCP request.
 * The user comes from `authInfo` (set by `verifyClerkToken`), never from tool input.
 */
export async function createSignInLink(
  options: SignInLinkOptions,
  request: SignInLinkRequest,
): Promise<SignInLink> {
  validateSignInLinkOptions(options);
  return requestSignInLink(options, request);
}

// `options` must already have passed validateSignInLinkOptions.
async function requestSignInLink(
  options: SignInLinkOptions,
  request: SignInLinkRequest,
): Promise<SignInLink> {
  const { authInfo } = request;
  if (!isClerkAuthInfo(authInfo)) {
    throw new SignInLinkError('not_authenticated', 'A Clerk-verified signed-in user is required');
  }

  const missingScopes = options.requiredScopes.filter((scope) => !authInfo.scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new SignInLinkError(
      'insufficient_scope',
      `The token is missing required scopes: ${missingScopes.join(', ')}`,
      missingScopes,
    );
  }

  const redirectUrl = resolveRedirectUrl(options.destinationUrl, request.path);
  const agentName =
    options.agentName?.trim() || (authInfo.clientId ? `mcp:${authInfo.clientId}` : 'mcp');
  const body = {
    on_behalf_of: { user_id: authInfo.extra.userId },
    permissions: '*',
    agent_name: agentName,
    task_description: request.taskDescription?.trim() || DEFAULT_TASK_DESCRIPTION,
    redirect_url: redirectUrl,
    ...(options.sessionMaxDurationInSeconds !== undefined && {
      session_max_duration_in_seconds: options.sessionMaxDurationInSeconds,
    }),
  };

  // Error messages never carry the response body, the secret key, or the link.
  let response: Response;
  try {
    response = await postBackendApi('/v1/agents/tasks', body, options);
  } catch {
    throw new SignInLinkError('unavailable', 'Clerk could not be reached');
  }
  if (!response.ok) {
    // Release the connection; the body is never read.
    await response.body?.cancel().catch(() => {});
    throw errorForStatus(response.status, request.path !== undefined);
  }

  const result = agentTaskResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!result.success) {
    throw new SignInLinkError('unavailable', 'Clerk returned an unreadable response');
  }
  return {
    url: result.data.url,
    agent_task_id: result.data.agent_task_id,
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
  redirect_url: z.string(),
};

/** Arguments for `McpServer.registerTool`. */
export type SignInLinkTool = McpToolTuple<
  typeof CREATE_BROWSER_SESSION_TOOL_NAME,
  typeof signInLinkInputSchema,
  typeof signInLinkOutputSchema
>;

function toolError(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

/** Returns the message for the agent after a failed `createSignInLink`. It never includes the link, response body, or secret key. */
export function signInLinkErrorMessage(error: SignInLinkError): string {
  switch (error.code) {
    case 'not_authenticated':
      return 'No signed-in user is available for this request. Ask the user to reconnect this MCP server and sign in, then try again.';
    case 'invalid_path':
      return 'The path is not allowed. Use an absolute path such as /settings, or omit it to open the default page.';
    case 'insufficient_scope':
      return `The token is missing required scopes: ${error.missingScopes.join(', ')}. Ask the user to reconnect this MCP server and approve those scopes, then try again.`;
    case 'rejected':
      return 'Clerk rejected the request. Do not retry. Tell the user the sign-in link could not be created.';
    case 'path_rejected':
      return 'Clerk rejected the request. Try again with a different path, or omit the path to open the default page.';
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
 * Builds the `create_browser_session` tool. Register it with `server.registerTool(...signInLinkTool(options))`.
 * Throws when the options cannot work.
 */
export function signInLinkTool(options: SignInLinkOptions): SignInLinkTool {
  validateSignInLinkOptions(options);

  const callback: ToolCallback<typeof signInLinkInputSchema> = async (input, extra) => {
    try {
      const link = await requestSignInLink(options, {
        authInfo: extra.authInfo,
        path: input.path,
        taskDescription: input.task_description,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Open this single use link in the browser to sign in: ${link.url}`,
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
    CREATE_BROWSER_SESSION_TOOL_NAME,
    {
      title: 'Get a signed-in browser link',
      description: SIGN_IN_LINK_DESCRIPTION,
      inputSchema: signInLinkInputSchema,
      outputSchema: signInLinkOutputSchema,
      annotations: OPEN_WORLD_WRITE_ANNOTATIONS,
    },
    callback,
  ];
}
