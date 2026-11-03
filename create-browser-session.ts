import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod/v4';

import {
  type BackendApiClient,
  type BackendApiOptions,
  createBackendApiClient,
  IDENTIFIER_PATTERN,
  parseAllowedUrl,
  safeErrorName,
} from './backend-api';
import {
  type McpToolTuple,
  OPEN_WORLD_WRITE_ANNOTATIONS,
  toolAuthInfo,
  toolError,
  toolResult,
} from './mcp-tool';
import { assertScopeTokens, missingScopes, scopeChallengeFor } from './scope-challenge';
import { isClerkAuthInfo } from './server';

export const CREATE_BROWSER_SESSION_TOOL_NAME = 'create_browser_session';

const DEFAULT_TASK_DESCRIPTION = 'Signed-in browser session requested through MCP';

export type CreateBrowserSessionOptions = BackendApiOptions & {
  /** Default landing page for the link. HTTPS, or HTTP on loopback. */
  destinationUrl: string;
  /** Name recorded for the agent. Defaults to `mcp:<client id>`, or `mcp`, when unset or blank. */
  agentName?: string;
  /**
   * Maximum length, in seconds, of the browser session the link starts. Clerk's default is 30 minutes.
   * Must be a positive integer.
   */
  sessionMaxDurationInSeconds?: number;
  /** Scopes the token must carry. Missing scopes refuse the request before any API call. Pass `[]` for none. */
  requiredScopes: readonly string[];
};

export type CreateBrowserSessionRequest = {
  /** Auth info produced by `verifyClerkToken`. The signed-in user is taken from here only. */
  authInfo: AuthInfo | undefined;
  /** Path (with optional query and hash) on the destination origin to land on. */
  path?: string;
  /** Short description of why the link is needed. */
  taskDescription?: string;
};

export type BrowserSession = {
  /** One-time link. Treat it as a credential: never log it. */
  url: string;
  agentTaskId: string;
  /** Where the browser lands after sign-in. */
  redirectUrl: string;
};

export type BrowserSessionErrorCode =
  | 'not_authenticated'
  | 'invalid_path'
  | 'rejected'
  | 'destination_rejected'
  | 'insufficient_scope'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable';

export class BrowserSessionError extends Error {
  constructor(
    readonly code: BrowserSessionErrorCode,
    message: string,
    /** The scopes the token lacks, for `insufficient_scope`. */
    readonly missingScopes: readonly string[] = [],
    /** Safe to log: status, error codes, or an error name. Never the link, the key, or response text. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

// The copy for each code: `message` is the error's own message, `agent` is the text the agent reads.
const ERROR_COPY = {
  not_authenticated: {
    message: 'A Clerk-verified signed-in user is required',
    agent: () =>
      'No signed-in user is available for this request. Ask the user to reconnect this MCP server and sign in, then try again.',
  },
  invalid_path: {
    message: 'path must start with a single "/" and stay on the app',
    agent: () =>
      'The path is not allowed. Use an absolute path such as /settings, or omit it to open the default page.',
  },
  insufficient_scope: {
    message: 'The token is missing required scopes',
    agent: (error) =>
      `The token is missing required scopes: ${error.missingScopes.join(', ')}. Ask the user to reconnect this MCP server and approve those scopes, then try again. If the scopes are still missing, tell the user the server owner must check the configuration. Do not retry more than once.`,
  },
  rejected: {
    message: 'Clerk rejected the sign-in link request',
    agent: () =>
      'Clerk rejected the request. Do not retry. Tell the user the sign-in link could not be created.',
  },
  destination_rejected: {
    message: 'Clerk does not allow the destination of the sign-in link',
    agent: () =>
      "Clerk does not allow this server's sign-in link destination. Tell the user the server owner must check the Clerk configuration. Do not retry.",
  },
  unauthorized: {
    message: 'Clerk rejected the server credentials',
    agent: () =>
      'The server is not authorized to create sign-in links. Tell the user the server owner must check the Clerk configuration. Do not retry.',
  },
  rate_limited: {
    message: 'Too many sign-in links were requested',
    agent: () => 'Too many sign-in links were requested. Wait a while before you try again.',
  },
  unavailable: {
    message: 'Clerk could not create a sign-in link',
    agent: () =>
      'Clerk could not create a sign-in link right now, and a link may already exist. Try again at most once, then continue without it or ask the user to sign in.',
  },
} satisfies Record<
  BrowserSessionErrorCode,
  { message: string; agent: (error: BrowserSessionError) => string }
>;

function sessionError(
  code: BrowserSessionErrorCode,
  detail?: string,
  missing: readonly string[] = [],
) {
  return new BrowserSessionError(code, ERROR_COPY[code].message, missing, detail);
}

type BrowserSessionConfig = Pick<
  CreateBrowserSessionOptions,
  'requiredScopes' | 'agentName' | 'sessionMaxDurationInSeconds'
> & { client: BackendApiClient; destination: URL };

function parseDestinationUrl(destinationUrl: string): URL {
  const destination = parseAllowedUrl(destinationUrl);
  if (!destination) {
    throw new Error(
      'Clerk error: createBrowserSession destinationUrl must be a URL that uses HTTPS or loopback HTTP',
    );
  }
  // The destination goes into the link, the tool result, and Clerk's ticket, so it must not carry credentials.
  if (destination.username || destination.password) {
    throw new Error(
      'Clerk error: createBrowserSession destinationUrl must not contain a username or password',
    );
  }
  return destination;
}

function resolveBrowserSessionConfig(options: CreateBrowserSessionOptions): BrowserSessionConfig {
  const client = createBackendApiClient('createBrowserSession', options);
  const destination = parseDestinationUrl(options.destinationUrl);
  if (!Array.isArray(options.requiredScopes)) {
    throw new Error(
      'Clerk error: createBrowserSession requiredScopes must be an array of scopes; pass [] to require none',
    );
  }
  assertScopeTokens('createBrowserSession', 'requiredScopes', options.requiredScopes);
  if (options.agentName !== undefined && typeof options.agentName !== 'string') {
    throw new Error('Clerk error: createBrowserSession agentName must be a string');
  }
  const seconds = options.sessionMaxDurationInSeconds;
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds <= 0)) {
    throw new Error(
      'Clerk error: createBrowserSession sessionMaxDurationInSeconds must be a positive integer',
    );
  }
  return {
    client,
    destination,
    requiredScopes: options.requiredScopes,
    agentName: options.agentName,
    sessionMaxDurationInSeconds: seconds,
  };
}

/**
 * Throws a `Clerk error:` message when the options cannot work. `createBrowserSessionTool` and `createBrowserSession` call it
 * too; call it at startup to fail fast on a bad configuration.
 */
export function validateBrowserSessionOptions(options: CreateBrowserSessionOptions): void {
  resolveBrowserSessionConfig(options);
}

// Resolves the agent's `path` against the origin of `destination`. Refuses anything that could leave that origin.
function resolveRedirectUrl(destination: URL, path: string | undefined): string {
  if (!path?.trim()) {
    return destination.href;
  }
  // The origin check below would accept `//app.example.com/x`; a path that names a host is still refused.
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    throw sessionError('invalid_path');
  }
  const { origin } = destination;
  let resolved: URL;
  try {
    resolved = new URL(path, origin);
  } catch {
    throw sessionError('invalid_path');
  }
  if (resolved.origin !== origin || resolved.pathname.startsWith('//')) {
    throw sessionError('invalid_path');
  }
  // URL keeps a malformed escape such as `%ZZ`, but Clerk rejects it as a bad redirect_url, which would read as a
  // server configuration error instead of a path the agent can fix.
  if (/%(?![0-9a-f]{2})/i.test(resolved.href.slice(origin.length))) {
    throw sessionError('invalid_path');
  }
  return resolved.href;
}

const identifier = z.string().regex(IDENTIFIER_PATTERN);

const apiErrorsSchema = z.object({
  errors: z.array(
    z.object({
      code: identifier.optional().catch(undefined),
      meta: z
        .object({ param_name: identifier.optional().catch(undefined) })
        .optional()
        .catch(undefined),
    }),
  ),
});

type ApiError = z.infer<typeof apiErrorsSchema>['errors'][number];

// Only the codes and parameter names are read from the body; its messages never reach a log or the agent.
function apiErrors(body: unknown): ApiError[] {
  const result = apiErrorsSchema.safeParse(body);
  return result.success ? result.data.errors : [];
}

function statusDetail(status: number, errors: readonly ApiError[]): string {
  const details = errors
    .map((error) => [error.code, error.meta?.param_name].filter(Boolean).join(' '))
    .filter(Boolean);
  return details.length > 0 ? `status ${status}: ${details.join(', ')}` : `status ${status}`;
}

function errorForStatus(status: number, errors: readonly ApiError[]): BrowserSessionError {
  const detail = statusDetail(status, errors);
  if (status === 401 || status === 403) return sessionError('unauthorized', detail);
  if (status === 429) return sessionError('rate_limited', detail);
  // Clerk checks the redirect URL's scheme and host, never its path, so this is the destination's configuration.
  if (status === 422 && errors.some((error) => error.meta?.param_name === 'redirect_url')) {
    return sessionError('destination_rejected', detail);
  }
  if (status >= 400 && status < 500) return sessionError('rejected', detail);
  return sessionError('unavailable', detail);
}

const agentTaskResponseSchema = z.object({ url: z.string(), agent_task_id: z.string() });

/**
 * Creates a one-time link that opens the app in a browser as the user who authorized the MCP request.
 * The user comes from `authInfo` (set by `verifyClerkToken`), never from tool input.
 */
export async function createBrowserSession(
  request: CreateBrowserSessionRequest,
  options: CreateBrowserSessionOptions,
): Promise<BrowserSession> {
  return requestBrowserSession(request, resolveBrowserSessionConfig(options));
}

// Throws a BrowserSessionError. Nothing reaches the log here: the tool callback logs `error.detail`.
async function requestBrowserSession(
  request: CreateBrowserSessionRequest,
  config: BrowserSessionConfig,
): Promise<BrowserSession> {
  const { authInfo } = request;
  if (!isClerkAuthInfo(authInfo)) throw sessionError('not_authenticated');

  const missing = missingScopes(config.requiredScopes, authInfo);
  if (missing.length > 0) {
    throw sessionError('insufficient_scope', `insufficient_scope: ${missing.join(' ')}`, missing);
  }

  const redirectUrl = resolveRedirectUrl(config.destination, request.path);
  const agentName =
    config.agentName?.trim() || (authInfo.clientId ? `mcp:${authInfo.clientId}` : 'mcp');
  const body = {
    on_behalf_of: { user_id: authInfo.extra.userId },
    permissions: '*',
    agent_name: agentName,
    task_description: request.taskDescription?.trim() || DEFAULT_TASK_DESCRIPTION,
    redirect_url: redirectUrl,
    ...(config.sessionMaxDurationInSeconds !== undefined && {
      session_max_duration_in_seconds: config.sessionMaxDurationInSeconds,
    }),
  };

  let response: Response;
  try {
    response = await config.client.post('/v1/agents/tasks', body);
  } catch (error) {
    throw sessionError('unavailable', safeErrorName(error));
  }
  const responseBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw errorForStatus(response.status, apiErrors(responseBody));
  }

  const result = agentTaskResponseSchema.safeParse(responseBody);
  if (!result.success) {
    throw sessionError('unavailable', `unreadable response with status ${response.status}`);
  }
  return { url: result.data.url, agentTaskId: result.data.agent_task_id, redirectUrl };
}

/**
 * Server instructions to pass as `new McpServer(info, { instructions })`. Some clients show agents only the server
 * instructions until they search for a tool, so the first sentence names the host and the tool.
 */
export function browserSessionInstructions(destinationUrl: string): string {
  const { host } = parseDestinationUrl(destinationUrl);
  // The safety sentence and the tool name come first: a client that truncates to ~200 characters still keeps them.
  return `Never type credentials for ${host}. To use ${host} in a browser, first call ${CREATE_BROWSER_SESSION_TOOL_NAME}: it opens ${host} signed in as the user.`;
}

/** The tool title and description, written for the app at `destinationUrl` so agents can match it to the site. */
export function browserSessionToolText(destinationUrl: string): {
  title: string;
  description: string;
} {
  return toolText(parseDestinationUrl(destinationUrl));
}

function toolText({ host, origin }: URL): { title: string; description: string } {
  return {
    title: `Open ${host} signed in`,
    description: [
      `Opens ${origin} in a browser already signed in as the current user, with no password or sign-in step.`,
      `Use this before you open any page on ${host} in a browser, and also if you reach its sign-in page.`,
      `Never type credentials for ${host}.`,
      'Call it with the path you want (for example /settings), then open the returned URL in the browser right away:',
      'it works once and expires in about 1 hour. Do not print or share the URL.',
    ].join(' '),
  };
}

export const browserSessionInputSchema = {
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

const browserSessionOutputSchema = {
  url: z.string(),
  agent_task_id: z.string(),
  redirect_url: z.string(),
};

/** Arguments for `McpServer.registerTool`. */
export type CreateBrowserSessionTool = McpToolTuple<
  typeof CREATE_BROWSER_SESSION_TOOL_NAME,
  typeof browserSessionInputSchema,
  typeof browserSessionOutputSchema
>;

/** The message for the agent after a failed `createBrowserSession`. It never includes the link or secret key. */
export function browserSessionErrorMessage(error: BrowserSessionError): string {
  return ERROR_COPY[error.code].agent(error);
}

/**
 * Builds the `create_browser_session` tool. Register it with `server.registerTool(...createBrowserSessionTool(options))`.
 * Throws when the options cannot work.
 */
export function createBrowserSessionTool(
  options: CreateBrowserSessionOptions,
): CreateBrowserSessionTool {
  const config = resolveBrowserSessionConfig(options);

  const callback: CreateBrowserSessionTool[2] = async (input, extra) => {
    try {
      const link = await requestBrowserSession(
        {
          authInfo: toolAuthInfo(extra),
          path: input.path,
          taskDescription: input.task_description,
        },
        config,
      );
      return toolResult(`Open this single use link in the browser to sign in: ${link.url}`, {
        url: link.url,
        agent_task_id: link.agentTaskId,
        redirect_url: link.redirectUrl,
      });
    } catch (error) {
      if (error instanceof BrowserSessionError) {
        // The path is agent input and stays out of the log; `detail` holds only safe text.
        console.error(`Clerk error: createBrowserSession failed (${error.detail ?? error.code})`);
        return toolError(browserSessionErrorMessage(error));
      }
      // Not the message or stack: they could carry the link or the key.
      console.error(
        `Clerk error: createBrowserSession tool failed unexpectedly (${safeErrorName(error)})`,
      );
      return toolError(
        'The sign-in link could not be created. Continue without it, or ask the user to sign in.',
      );
    }
  };

  return [
    CREATE_BROWSER_SESSION_TOOL_NAME,
    {
      ...toolText(config.destination),
      inputSchema: browserSessionInputSchema,
      outputSchema: browserSessionOutputSchema,
      annotations: OPEN_WORLD_WRITE_ANNOTATIONS,
      scopeChallenge: scopeChallengeFor(config.requiredScopes),
    },
    callback,
  ];
}
