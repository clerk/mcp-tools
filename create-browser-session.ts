import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod/v4';

import {
  type BackendApiClient,
  type BackendApiOptions,
  createBackendApiClient,
  parseAllowedUrl,
  requireSecretKey,
} from './backend-api';
import {
  type McpToolTuple,
  OPEN_WORLD_WRITE_ANNOTATIONS,
  toolAuthInfo,
  toolError,
  toolResult,
} from './mcp-tool';
import { assertScopeTokens, missingScopes, registrationScopeChallenge } from './scope-challenge';
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
  ) {
    super(message);
    this.name = 'BrowserSessionError';
  }
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
  requireSecretKey('createBrowserSession', options);
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

const INVALID_PATH_MESSAGE = 'path must start with a single "/" and stay on the app';

// Resolves the agent's `path` against the origin of `destination`. Refuses anything that could leave that origin.
function resolveRedirectUrl(destination: URL, path: string | undefined): string {
  if (!path?.trim()) {
    return destination.href;
  }
  // The origin check below would accept `//app.example.com/x`; a path that names a host is still refused.
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    throw new BrowserSessionError('invalid_path', INVALID_PATH_MESSAGE);
  }
  const { origin } = destination;
  let resolved: URL;
  try {
    resolved = new URL(path, origin);
  } catch {
    throw new BrowserSessionError('invalid_path', INVALID_PATH_MESSAGE);
  }
  if (resolved.origin !== origin || resolved.pathname.startsWith('//')) {
    throw new BrowserSessionError('invalid_path', INVALID_PATH_MESSAGE);
  }
  // URL keeps a malformed escape such as `%ZZ`, but Clerk rejects it as a bad redirect_url, which would read as a
  // server configuration error instead of a path the agent can fix.
  if (/%(?![0-9a-f]{2})/i.test(resolved.href.slice(origin.length))) {
    throw new BrowserSessionError('invalid_path', INVALID_PATH_MESSAGE);
  }
  return resolved.href;
}

// Error codes, parameter names, and error names are identifiers. Anything else in them (a proxy's text, the link)
// is dropped.
const identifier = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/i);

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

function errorForStatus(status: number, errors: readonly ApiError[]): BrowserSessionError {
  if (status === 401 || status === 403) {
    return new BrowserSessionError('unauthorized', 'Clerk rejected the server credentials');
  }
  if (status === 429) {
    return new BrowserSessionError('rate_limited', 'Too many sign-in links were requested');
  }
  // Clerk checks the redirect URL's scheme and host, never its path, so this is the destination's configuration.
  if (status === 422 && errors.some((error) => error.meta?.param_name === 'redirect_url')) {
    return new BrowserSessionError(
      'destination_rejected',
      'Clerk does not allow the destination of the sign-in link',
    );
  }
  if (status >= 400 && status < 500) {
    return new BrowserSessionError('rejected', 'Clerk rejected the sign-in link request');
  }
  return new BrowserSessionError('unavailable', 'Clerk could not create a sign-in link');
}

const agentTaskResponseSchema = z.object({ url: z.string(), agent_task_id: z.string() });

// Never the body text or a custom fetch's error message: they could carry the link or the key.
function logFailure(reason: string) {
  console.error(`Clerk error: createBrowserSession failed (${reason})`);
}

function statusReason(status: number, errors: readonly ApiError[]): string {
  const details = errors
    .map((error) => [error.code, error.meta?.param_name].filter(Boolean).join(' '))
    .filter(Boolean);
  return details.length > 0 ? `status ${status}: ${details.join(', ')}` : `status ${status}`;
}

// The path is agent input and stays out of the log; scope names come from the server's own options.
function logRejection(error: BrowserSessionError) {
  const reason =
    error.missingScopes.length > 0 ? `${error.code}: ${error.missingScopes.join(' ')}` : error.code;
  console.error(`Clerk error: createBrowserSession rejected (${reason})`);
}

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

// Checks the request and builds the agent task body. Throws a BrowserSessionError before anything reaches Clerk.
function buildAgentTaskBody(request: CreateBrowserSessionRequest, config: BrowserSessionConfig) {
  const { authInfo } = request;
  if (!isClerkAuthInfo(authInfo)) {
    throw new BrowserSessionError(
      'not_authenticated',
      'A Clerk-verified signed-in user is required',
    );
  }

  const missing = missingScopes(config.requiredScopes, authInfo);
  if (missing.length > 0) {
    throw new BrowserSessionError(
      'insufficient_scope',
      `The token is missing required scopes: ${missing.join(', ')}`,
      missing,
    );
  }

  const redirectUrl = resolveRedirectUrl(config.destination, request.path);
  const agentName =
    config.agentName?.trim() || (authInfo.clientId ? `mcp:${authInfo.clientId}` : 'mcp');
  return {
    on_behalf_of: { user_id: authInfo.extra.userId },
    permissions: '*',
    agent_name: agentName,
    task_description: request.taskDescription?.trim() || DEFAULT_TASK_DESCRIPTION,
    redirect_url: redirectUrl,
    ...(config.sessionMaxDurationInSeconds !== undefined && {
      session_max_duration_in_seconds: config.sessionMaxDurationInSeconds,
    }),
  };
}

async function requestBrowserSession(
  request: CreateBrowserSessionRequest,
  config: BrowserSessionConfig,
): Promise<BrowserSession> {
  let body: ReturnType<typeof buildAgentTaskBody>;
  try {
    body = buildAgentTaskBody(request, config);
  } catch (error) {
    if (error instanceof BrowserSessionError) logRejection(error);
    throw error;
  }

  let response: Response;
  try {
    response = await config.client.post('/v1/agents/tasks', body);
  } catch (error) {
    // A custom fetch can set any name, so only an identifier-shaped one is logged.
    const name = error instanceof Error ? identifier.safeParse(error.name) : undefined;
    logFailure(name?.success ? name.data : 'unknown error');
    throw new BrowserSessionError('unavailable', 'Clerk could not be reached');
  }
  const responseBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errors = apiErrors(responseBody);
    logFailure(statusReason(response.status, errors));
    throw errorForStatus(response.status, errors);
  }

  const result = agentTaskResponseSchema.safeParse(responseBody);
  if (!result.success) {
    logFailure(`unreadable response with status ${response.status}`);
    throw new BrowserSessionError('unavailable', 'Clerk returned an unreadable response');
  }
  return {
    url: result.data.url,
    agentTaskId: result.data.agent_task_id,
    redirectUrl: body.redirect_url,
  };
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
  switch (error.code) {
    case 'not_authenticated':
      return 'No signed-in user is available for this request. Ask the user to reconnect this MCP server and sign in, then try again.';
    case 'invalid_path':
      return 'The path is not allowed. Use an absolute path such as /settings, or omit it to open the default page.';
    case 'insufficient_scope':
      return `The token is missing required scopes: ${error.missingScopes.join(', ')}. Ask the user to reconnect this MCP server and approve those scopes, then try again. If the scopes are still missing, tell the user the server owner must check the configuration. Do not retry more than once.`;
    case 'rejected':
      return 'Clerk rejected the request. Do not retry. Tell the user the sign-in link could not be created.';
    case 'destination_rejected':
      return "Clerk does not allow this server's sign-in link destination. Tell the user the server owner must check the Clerk configuration. Do not retry.";
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
        return toolError(browserSessionErrorMessage(error));
      }
      // Not the message or stack: they could carry the link or the key. A custom error can set any name.
      const name = error instanceof Error ? identifier.safeParse(error.name) : undefined;
      console.error(
        `Clerk error: createBrowserSession tool failed unexpectedly (${name?.success ? name.data : 'unknown error'})`,
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
      scopeChallenge: registrationScopeChallenge(config.requiredScopes),
    },
    callback,
  ];
}
