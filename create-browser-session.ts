import type { AuthInfo } from './mcp-types';
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
  isSdkV2Extra,
  type McpToolTuple,
  OPEN_WORLD_WRITE_ANNOTATIONS,
  toolAuthInfo,
  toolError,
  toolResult,
} from './mcp-tool';
import { assertScopeTokens, missingScopes, requireAdditionalScopes } from './scope-challenge';
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
  /**
   * Scopes the token must carry. Missing scopes refuse the request before any API call. Prefer a scope dedicated to this
   * tool over one that most clients get, such as `profile`. Pass `[]` for none.
   */
  requiredScopes: readonly string[];
  /**
   * Limits the session the link starts. Clerk's Frontend API refuses these writes from that session: touch, switching
   * the active session or organization, sign-out, the user's own profile and organization writes, reverification, and
   * OAuth consent and approval. The one exception is refreshing its own session token. Clerk enforces this, not your
   * app's own backend, which sees an ordinary signed-in session unless it checks for an agent session itself. Defaults to
   * `true`; pass `false` for an ordinary session. When `true`, the link is refused with `restricted_not_applied`
   * unless Clerk confirms the restriction in its response.
   */
  restricted?: boolean;
};

export type CreateBrowserSessionRequest = {
  /** Auth info produced by `toClerkAuthInfo`. The signed-in user is taken from here only. */
  authInfo: AuthInfo | undefined;
  /** Path (with optional query and hash) on the destination origin to land on. */
  path?: string;
  /** Short description of why the link is needed. */
  taskDescription?: string;
  /**
   * Organization the session starts in, and with `restricted`, the only one it can use. Clerk defaults to the user's last
   * active organization. When set, the link is refused with `restricted_not_applied` unless Clerk confirms it.
   */
  organizationId?: string;
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
  | 'unavailable'
  | 'organization_rejected'
  | 'restricted_not_applied';

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
  organization_rejected: {
    message: 'Clerk refused the organization for the sign-in link',
    agent: () =>
      'Clerk refused the workspace for this sign-in link: the user may no longer belong to it, or the app requires one. Do not retry. Ask the user to reconnect this MCP server and choose a workspace they belong to.',
  },
  restricted_not_applied: {
    message: 'Clerk did not confirm the restrictions on the sign-in link',
    agent: () =>
      'The browser session could not be created with the required restrictions. Do not retry. Ask the user to contact the server operator.',
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
> & { restricted: boolean; client: BackendApiClient; destination: URL };

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
  // Missing scopes go in the log, so a scope shaped like a Clerk key would leak one.
  if (options.requiredScopes.some((scope) => KEY_SHAPE.test(scope))) {
    throw new Error(
      'Clerk error: createBrowserSession requiredScopes must not contain a Clerk key',
    );
  }
  if (options.agentName !== undefined && typeof options.agentName !== 'string') {
    throw new Error('Clerk error: createBrowserSession agentName must be a string');
  }
  const seconds = options.sessionMaxDurationInSeconds;
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds <= 0)) {
    throw new Error(
      'Clerk error: createBrowserSession sessionMaxDurationInSeconds must be a positive integer',
    );
  }
  if (options.restricted !== undefined && typeof options.restricted !== 'boolean') {
    throw new Error('Clerk error: createBrowserSession restricted must be a boolean');
  }
  return {
    client,
    destination,
    restricted: options.restricted ?? true,
    // A frozen copy: the caller emptying its array later must not turn the check off.
    requiredScopes: Object.freeze([...options.requiredScopes]),
    agentName: options.agentName,
    sessionMaxDurationInSeconds: seconds,
  };
}

/**
 * Throws a `Clerk error:` message when the options cannot work. `createBrowserSessionTool` and `createBrowserSession` run
 * the same check, so a tool built at module scope fails fast on a bad configuration.
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

const ORGANIZATION_ERROR_CODES = new Set([
  'organization_not_found_or_unauthorized',
  'agent_task_organization_required',
]);

function errorForStatus(status: number, errors: readonly ApiError[]): BrowserSessionError {
  const detail = statusDetail(status, errors);
  if (status === 401 || status === 403) return sessionError('unauthorized', detail);
  if (status === 429) return sessionError('rate_limited', detail);
  if (
    errors.some((error) => error.code !== undefined && ORGANIZATION_ERROR_CODES.has(error.code))
  ) {
    return sessionError('organization_rejected', detail);
  }
  // Clerk checks the redirect URL's scheme and host, never its path, so this is the destination's configuration.
  if (status === 422 && errors.some((error) => error.meta?.param_name === 'redirect_url')) {
    return sessionError('destination_rejected', detail);
  }
  if (status >= 400 && status < 500) return sessionError('rejected', detail);
  return sessionError('unavailable', detail);
}

const agentTaskResponseSchema = z.object({
  url: z.string(),
  agent_task_id: z.string(),
  session_restricted: z.unknown().optional(),
  session_organization_id: z.unknown().optional(),
});

// A Clerk key shape (`sk_...`, `pk_...`) at the start or after a `.`, `_`, `:`, or `-` boundary, for text that does
// not fit IDENTIFIER_PATTERN.
const KEY_SHAPE = /(?:^|[._:-])[sp]k_/i;

// An agent_task_id that fails IDENTIFIER_PATTERN (too long, or a character such as `-` that a future id format could
// use) must stay out of the log, but it can still name the task to revoke when it is one plain path segment. No `.`,
// so `encodeURIComponent` cannot leave a `.` or `..` segment that the URL parser would resolve to another endpoint,
// and no key shape, so a custom `fetch` that logs request URLs never sees one.
const REVOCABLE_TASK_ID = /^[a-z0-9_-]{1,128}$/i;

function isRevocableTaskId(agentTaskId: string): boolean {
  return REVOCABLE_TASK_ID.test(agentTaskId) && !KEY_SHAPE.test(agentTaskId);
}

// Best effort: Clerk already created the task, and the refusal must not depend on the revoke.
// Resolves to whether Clerk accepted the revoke.
async function revokeAgentTask(client: BackendApiClient, agentTaskId: string): Promise<boolean> {
  try {
    const response = await client.post(
      `/v1/agents/tasks/${encodeURIComponent(agentTaskId)}/revoke`,
      {},
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Creates a one-time link that opens the app in a browser as the user who authorized the MCP request.
 * The user comes from `authInfo` (set by `toClerkAuthInfo`), never from tool input.
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
    throw sessionError('insufficient_scope', missing.join(' '), missing);
  }

  const redirectUrl = resolveRedirectUrl(config.destination, request.path);
  const agentName =
    config.agentName?.trim() || (authInfo.clientId ? `mcp:${authInfo.clientId}` : 'mcp');
  const body = {
    on_behalf_of: { user_id: authInfo.extra.userId },
    permissions: '*',
    session_restricted: config.restricted,
    ...(request.organizationId !== undefined && {
      session_organization_id: request.organizationId,
    }),
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
  // Older Clerk versions ignore `session_restricted` and `session_organization_id`, so only this confirmation proves
  // the session is limited.
  const { agent_task_id: agentTaskId, url } = result.data;
  const validId = IDENTIFIER_PATTERN.test(agentTaskId);
  const unconfirmed =
    (config.restricted && result.data.session_restricted !== true) ||
    (request.organizationId !== undefined &&
      result.data.session_organization_id !== request.organizationId);
  if (unconfirmed) {
    // An id that is not an identifier is never logged. It is still revoked when it is a safe path segment. Otherwise
    // nothing safely names the task, so it is left to expire: the link is never returned or logged, and it works once,
    // for about an hour.
    if (!validId && !isRevocableTaskId(agentTaskId)) {
      throw sessionError('restricted_not_applied', 'agent_task_id invalid revoke_skipped');
    }
    const revoked = await revokeAgentTask(config.client, agentTaskId);
    throw sessionError(
      'restricted_not_applied',
      `agent_task_id ${validId ? agentTaskId : 'invalid'}${revoked ? '' : ' revoke_failed'}`,
    );
  }
  if (!validId) {
    throw sessionError('unavailable', `unreadable response with status ${response.status}`);
  }
  return { url, agentTaskId, redirectUrl };
}

/**
 * Server instructions to pass as `new McpServer(info, { instructions })`. Some clients show agents only the server
 * instructions until they search for a tool, so the tool name comes first.
 */
export function browserSessionInstructions(destinationUrl: string): string {
  const { host } = parseDestinationUrl(destinationUrl);
  // The tool name comes first, before any host: a client that truncates to ~200 characters still keeps it.
  return `First call ${CREATE_BROWSER_SESSION_TOOL_NAME} to use ${host} in a browser: it opens ${host} signed in as the user. Never type credentials for ${host}.`;
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

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

// SDK 2.1+ answers a missing scope with the step-up challenge before the callback runs, so a tool that sees one is on
// SDK 2.0. Module-level, so servers that build the tool per request still warn once.
const warnStepUpUnsupported = once(() =>
  console.warn(
    `Clerk warning: ${CREATE_BROWSER_SESSION_TOOL_NAME} returned its missing-scope error instead of a step-up challenge. MCP server SDK @modelcontextprotocol/server 2.1 or later sends the challenge before the tool runs; upgrade it, and keep the tool's scopeChallenge registration option.`,
  ),
);

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
        if (error.code === 'insufficient_scope' && isSdkV2Extra(extra)) warnStepUpUnsupported();
        // The path is agent input and stays out of the log; `detail` holds only safe text.
        console.error(
          `Clerk error: createBrowserSession failed (${error.code}${error.detail ? `: ${error.detail}` : ''})`,
        );
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
      ...(config.requiredScopes.length > 0 && {
        scopeChallenge: requireAdditionalScopes(
          ...(config.requiredScopes as readonly [string, ...string[]]),
        ),
      }),
    },
    callback,
  ];
}
