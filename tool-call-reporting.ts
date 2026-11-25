// Reports MCP tool calls to the Clerk Backend API. Not a package entry point.
import { version } from './package.json';
import type { AuthInfo } from './mcp-types';
import type { McpAuthFailure } from './server';
import {
  IDENTIFIER_PATTERN,
  createBackendApiClient,
  parseAllowedUrl,
  safeErrorName,
} from './backend-api';
import { hasClerkVerification } from './clerk-auth-info';
import { ERROR_CODE_META_KEY } from './mcp-tool';

/**
 * What `reporting` sends to Clerk for each tool call, and where. `reporting: true` is the same as `{}`:
 * every field below at its default. Each report has the tool's name, the MCP server's name, whether the call
 * succeeded, the error code of a failed call, how long it took, and when it was made. Tool arguments and results are
 * never sent.
 * @typeParam Req - The framework's request: the Express request, the Hono context, or the Next.js `Request`
 */
export type ReportingOptions<Req = never> = {
  /**
   * Whether to send the IP address of the MCP client. `true`, the default, reads it where the adapter can trust it:
   * `req.ip` in Express, which follows the app's `trust proxy` setting; `cf-connecting-ip` on Cloudflare Workers and
   * the socket's address on Node.js in Hono; and `x-real-ip` on Vercel in Next.js. Anywhere else no address is sent,
   * unless you pass a function that returns one from a source you trust, such as a header your proxy sets.
   */
  ipAddress?: boolean | ((request: Req) => string | null | undefined) | undefined;
  /**
   * Whether to send the MCP client's `User-Agent`, up to 512 characters. Defaults to `true`.
   */
  userAgent?: boolean | undefined;
  /**
   * Whether to send the Clerk user ID, OAuth client ID, access token ID, and organization ID of a token Clerk
   * verified. Defaults to `true`. Tokens a `verifyToken` function verified never send them.
   */
  identity?: boolean | undefined;
  /**
   * Decides which tools are reported: a call to a tool it returns `false` for is not sent. Every tool is reported
   * without it.
   */
  tools?: ((toolName: string) => boolean) | undefined;
  /**
   * The server name to report. Defaults to the name the MCP server was created with.
   */
  serverName?: string | undefined;
  /**
   * The secret key of the Clerk instance the reports belong to. Defaults to the `CLERK_SECRET_KEY` environment
   * variable.
   */
  secretKey?: string | undefined;
  /**
   * The origin of the Clerk Backend API. Defaults to the `CLERK_API_URL` environment variable, then
   * `https://api.clerk.com`.
   */
  apiUrl?: string | undefined;
  /**
   * Sends the reports. Defaults to the global `fetch`.
   */
  fetch?: typeof fetch | undefined;
};

/**
 * The `reporting` option every `clerkInstrumentHandler` takes, for the framework's request `Req`.
 */
export type ReportingOption<Req> = {
  /**
   * Reports each tool call that `clerkInstrumentHandler` authenticated and a `clerkInstrumentServer` server answered
   * to Clerk, where it shows up in the instance's MCP analytics and audit log, along with that server's `initialize`,
   * list, resource read and prompt get requests, and each request it answered with a 401, 403 or 421. `true` reports with the defaults of `ReportingOptions`, and an options object turns individual
   * fields off. Off by default. Calls without a token, which `publicAccess` lets through, are not reported.
   */
  reporting?: boolean | ReportingOptions<Req> | undefined;
};

export const reportingKey = 'reporting';

export type ToolCallReporting<Req> = {
  ipAddress: boolean | ((request: Req) => string | null | undefined);
  userAgent: boolean;
  identity: boolean;
  tools: ((toolName: string) => boolean) | undefined;
  serverName: string | undefined;
  secretKey: string | undefined;
  apiUrl: string | undefined;
  fetch: typeof fetch | undefined;
};

const reportingKeys: ReadonlySet<string> = new Set<keyof ReportingOptions>([
  'ipAddress',
  'userAgent',
  'identity',
  'tools',
  'serverName',
  'secretKey',
  'apiUrl',
  'fetch',
]);

// Each pattern and limit matches the validation of `POST /v1/mcp_events`, which rejects a whole batch for one
// invalid field, so a value that would fail it is dropped here instead.
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_./-]{1,128}$/;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9 _.:@/-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const METHOD_PATTERN = /^[A-Za-z0-9_./-]{1,64}$/;
const VERIFIER_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// A client names itself, so its name and version are kept only in these shapes
const CLIENT_NAME_PATTERN = /^[A-Za-z0-9 _.:@()+/-]{1,128}$/;
const CLIENT_VERSION_PATTERN = /^[A-Za-z0-9 _.:@()+/-]{1,64}$/;
const PROTOCOL_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
// A resource template is the server's own string, such as `users://{id}/profile`: printable ASCII without spaces
const URI_TEMPLATE_PATTERN = /^[!-~]{1,256}$/;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{0,31}$/;
const MAX_ITEM_COUNT = 1_000_000;
const MAX_ERROR_CODE_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_.:~-]{1,128}$/;
const USER_ID_PATTERN = /^user_\w{27}$/;
const ORG_ID_PATTERN = /^org_\w{27}$/;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const IPV6_PATTERN =
  /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

const EVENTS_PATH = '/v1/mcp_events';
const MAX_BATCH_SIZE = 100;
const MAX_QUEUED = 1000;
// Auth failures come from requests without a valid token, so anyone can cause them. They wait in their own, smaller
// queue, so they never push out a tool call, and each reporter takes at most so many a minute.
const MAX_QUEUED_AUTH_FAILURES = 100;
const MAX_AUTH_FAILURES_PER_WINDOW = 100;
const AUTH_FAILURE_WINDOW_MS = 60 * 1000;
const MAX_IN_FLIGHT = 10;
// The Backend API answers 403 to an instance that MCP analytics is not enabled for
const STATUS_HINTS: Partial<Record<number, string>> = {
  401: '. Check the secret key',
  403: '. MCP analytics may not be enabled for this instance',
};
const FLUSH_DELAY_MS = 1000;
const SDK = { name: '@clerk/mcp-tools', version };

/**
 * Checks `reporting` when the handler is created.
 * @returns The settings with defaults filled in, or `undefined` when reporting is off. It throws a `Clerk error:`
 * naming the first option that is not valid.
 */
export function resolveReporting<Req>(
  caller: string,
  value: unknown,
): ToolCallReporting<Req> | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) value = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Clerk error: ${caller} reporting must be true, false, or an options object`);
  }
  const unknownKey = Object.keys(value).find((key) => !reportingKeys.has(key));
  if (unknownKey !== undefined) {
    throw new Error(
      `Clerk error: ${caller} reporting has no ${unknownKey} option. It takes any of ${[...reportingKeys].join(', ')}`,
    );
  }
  const options = value as ReportingOptions<Req>;
  const fail = (message: string): never => {
    throw new Error(`Clerk error: ${caller} reporting.${message}`);
  };
  const flag = (name: 'userAgent' | 'identity') => {
    const option = options[name];
    if (option !== undefined && typeof option !== 'boolean') fail(`${name} must be a boolean`);
    return option ?? true;
  };
  const { ipAddress, tools, serverName, secretKey, apiUrl, fetch: fetchImpl } = options;
  if (
    ipAddress !== undefined &&
    typeof ipAddress !== 'boolean' &&
    typeof ipAddress !== 'function'
  ) {
    fail('ipAddress must be a boolean or a function that returns the address');
  }
  if (tools !== undefined && typeof tools !== 'function') {
    fail('tools must be a function that returns whether to report a tool');
  }
  if (serverName !== undefined && !SERVER_NAME_PATTERN.test(String(serverName))) {
    fail('serverName must be 1 to 128 letters, digits, spaces, or any of _ . : @ / -');
  }
  if (secretKey !== undefined && (typeof secretKey !== 'string' || !secretKey.trim())) {
    fail('secretKey must be the secret key of a Clerk instance');
  }
  if (apiUrl !== undefined && (typeof apiUrl !== 'string' || !parseAllowedUrl(apiUrl))) {
    fail('apiUrl must use HTTPS or loopback HTTP');
  }
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') fail('fetch must be a function');
  return {
    ipAddress: ipAddress ?? true,
    userAgent: flag('userAgent'),
    identity: flag('identity'),
    tools,
    serverName,
    secretKey,
    apiUrl,
    fetch: fetchImpl,
  };
}

/**
 * Throws a `Clerk error:` when an entry point that cannot see tool calls is given `reporting`, and returns the
 * options without it.
 */
export function withoutReporting<T extends object>(caller: string, options: T): T {
  if (typeof options !== 'object' || options === null || !('reporting' in options)) {
    return options;
  }
  const { reporting, ...rest } = options as T & { reporting?: unknown };
  if (reporting !== undefined && reporting !== false) {
    throw new Error(
      `Clerk error: ${caller} cannot report tool calls. Serve the MCP route with clerkInstrumentHandler(handler, options), and call clerkInstrumentServer(server) where each server is created`,
    );
  }
  return rest as T;
}

// The fields every event type shares, in the snake_case of `POST /v1/mcp_events`
type McpEventBase = {
  occurred_at: number;
  server_name?: string;
  user_id?: string;
  client_id?: string;
  oauth_access_token_id?: string;
  org_id?: string;
  ip_address?: string;
  user_agent?: string;
  protocol_version?: string;
};

type ToolCallEvent = McpEventBase & {
  type: 'tool_call';
  tool_name: string;
  status: 'success' | 'error';
  error_code?: string;
  duration_ms: number;
  handler_ms?: number;
};

type AuthFailureEvent = McpEventBase & {
  type: 'auth_failure';
  reason: McpAuthFailure['reason'];
  http_status: number;
  verifier_code?: string;
  method?: string;
  tool_name?: string;
};

type ClientInitializedEvent = McpEventBase & {
  type: 'client_initialized';
  client_name?: string;
  client_version?: string;
  requested_protocol_version?: string;
};

type ListRequestEvent = McpEventBase & {
  type: 'list_request';
  method: string;
  item_count?: number;
};

type HandledRequestFields = {
  status: 'success' | 'error';
  error_code?: string;
  duration_ms: number;
  handler_ms?: number;
};

type ResourceReadEvent = McpEventBase &
  HandledRequestFields & {
    type: 'resource_read';
    resource_name?: string;
    resource_uri_template?: string;
    resource_uri_scheme?: string;
  };

type PromptGetEvent = McpEventBase &
  HandledRequestFields & {
    type: 'prompt_get';
    prompt_name: string;
    message_count?: number;
  };

type RequestEvent = ClientInitializedEvent | ListRequestEvent | ResourceReadEvent | PromptGetEvent;

type McpEvent = ToolCallEvent | AuthFailureEvent | RequestEvent;

type WithoutBase<Event> = Event extends unknown
  ? Omit<Event, keyof McpEventBase | keyof HandledRequestFields> &
      Pick<McpEventBase, 'protocol_version'>
  : never;

/**
 * The fields of a request event that the transport observes, before `ToolCallContext.startRequest` adds the time,
 * outcome, server and caller. Each value is dropped unless it has the shape the Backend API accepts.
 */
export type RequestEventFields = WithoutBase<RequestEvent>;

// The shape each observed value must have to be sent, matching `POST /v1/mcp_events`
const REQUEST_FIELD_PATTERNS: Record<string, RegExp> = {
  client_name: CLIENT_NAME_PATTERN,
  client_version: CLIENT_VERSION_PATTERN,
  requested_protocol_version: PROTOCOL_VERSION_PATTERN,
  protocol_version: PROTOCOL_VERSION_PATTERN,
  method: METHOD_PATTERN,
  resource_name: SERVER_NAME_PATTERN,
  resource_uri_template: URI_TEMPLATE_PATTERN,
  resource_uri_scheme: URI_SCHEME_PATTERN,
  // The name a client asked for, which may match no registered prompt, so it is held to the shape of a tool name
  prompt_name: TOOL_NAME_PATTERN,
};

const protocolVersionField = (protocolVersion: unknown) =>
  typeof protocolVersion === 'string' && PROTOCOL_VERSION_PATTERN.test(protocolVersion)
    ? { protocol_version: protocolVersion }
    : {};

const isCount = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ITEM_COUNT;

// The fields with the shape the Backend API accepts, or `undefined` when a required one is missing
function validRequestFields(fields: RequestEventFields): RequestEventFields | undefined {
  const valid = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => {
      if (key === 'type') return true;
      if (key === 'item_count' || key === 'message_count') return isCount(value);
      const pattern = REQUEST_FIELD_PATTERNS[key];
      return pattern !== undefined && typeof value === 'string' && pattern.test(value);
    }),
  ) as RequestEventFields;
  if (valid.type === 'list_request' && valid.method === undefined) return undefined;
  if (valid.type === 'prompt_get' && valid.prompt_name === undefined) return undefined;
  return valid;
}

type RequestDetails = Pick<
  McpEventBase,
  'user_id' | 'client_id' | 'oauth_access_token_id' | 'org_id' | 'ip_address' | 'user_agent'
>;

export type ToolCallOutcome = { status: 'success' | 'error'; errorCode?: string | undefined };

/**
 * One request's link between `clerkInstrumentHandler` and the servers `clerkInstrumentServer` instrumented, found from
 * the auth info the transport hands each message.
 */
export type ToolCallContext = {
  /**
   * Whether an instrumented server took a message of this request.
   */
  connected: boolean;
  /**
   * Starts timing a call to `toolName`, or returns `undefined` when it is not reported.
   * @returns A function that reports the call once it has an outcome
   */
  startToolCall(
    toolName: string,
    serverName: string | undefined,
    requestKey?: string | undefined,
    protocolVersion?: string | undefined,
  ): ((outcome: ToolCallOutcome) => void) | undefined;
  /**
   * Starts timing a request that is not a tool call, such as `initialize` or `resources/read`, or returns `undefined`
   * when it is not reported.
   * @returns A function that reports the request once it has a response, with the fields observed from it, and the
   * outcome of a resource read or prompt get
   */
  startRequest(
    serverName: string | undefined,
    requestKey: string,
  ): ((fields: RequestEventFields, outcome?: ToolCallOutcome) => void) | undefined;
  /**
   * Starts timing the handler of the call with `requestKey`, for that call's report.
   * @returns A function to call once the handler returns, with the error it threw, if any. A thrown error makes the
   * call an error with the code `thrown:<ErrorClass>`, whatever the response says.
   */
  startHandler(requestKey: string): (thrown: { error: unknown } | undefined) => void;
  /**
   * Sends every report that is waiting, including other requests'.
   */
  flush(): Promise<void>;
};

const contexts = new WeakMap<AuthInfo, ToolCallContext>();

export function toolCallContextOf(authInfo: unknown): ToolCallContext | undefined {
  return typeof authInfo === 'object' && authInfo !== null
    ? contexts.get(authInfo as AuthInfo)
    : undefined;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

const now = () => globalThis.performance?.now() ?? Date.now();

const elapsedMs = (startedAt: number) =>
  Math.min(Math.max(Math.round(now() - startedAt), 0), MAX_DURATION_MS);

type HandlerRecord = { handlerMs: number; thrownErrorCode: string | undefined };

/**
 * The error code of a handler that threw `error`: `thrown:` and the error's class name, never its message. That is its
 * `name` when it is a plain identifier other than `Error`, and otherwise its constructor's name, so a subclass that
 * keeps the name `Error` still reports its own. A value that is not an `Error`, or has neither name as a plain
 * identifier, is `thrown:unknown`.
 */
function thrownErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'thrown:unknown';
  const isIdentifier = (name: unknown): name is string =>
    typeof name === 'string' && IDENTIFIER_PATTERN.test(name);
  const constructorName = (error.constructor as { name?: unknown } | undefined)?.name;
  const name =
    isIdentifier(error.name) && error.name !== 'Error'
      ? error.name
      : isIdentifier(constructorName)
        ? constructorName
        : 'unknown';
  return `thrown:${name}`.slice(0, MAX_ERROR_CODE_LENGTH);
}

/**
 * Creates the request's context and links it to `authInfo`, the object the handler passes to the transport, so that
 * an instrumented server finds it on each message's `extra.authInfo`. A request without auth info has no context.
 */
export function beginToolCallContext<Req>({
  caller,
  reporting,
  authInfo,
  request,
  defaultIpAddress,
  userAgent,
  env,
}: {
  caller: string;
  reporting: ToolCallReporting<Req> | undefined;
  authInfo: AuthInfo | undefined;
  request: Req;
  defaultIpAddress: () => string | null | undefined;
  userAgent: () => string | null | undefined;
  env: { secretKey: string | undefined; apiUrl: string | undefined };
}): ToolCallContext | undefined {
  if (!authInfo) return undefined;
  const reporter = reporting && reporterFor(caller, reporting, env);
  const details =
    reporter &&
    reporting &&
    requestDetails(caller, reporting, authInfo, request, defaultIpAddress, userAgent);
  const handlers = new Map<string, HandlerRecord>();
  const takeHandler = (requestKey: string | undefined) => {
    if (requestKey === undefined) return undefined;
    const handler = handlers.get(requestKey);
    handlers.delete(requestKey);
    return handler;
  };
  // The outcome, time and handler time of a handled request. A handler that threw makes it an error, whatever the
  // response says.
  const handledFields = (
    outcome: ToolCallOutcome,
    handler: HandlerRecord | undefined,
    startedAt: number,
  ): HandledRequestFields => {
    const status = handler?.thrownErrorCode === undefined ? outcome.status : 'error';
    const errorCode = handler?.thrownErrorCode ?? outcome.errorCode;
    return {
      status,
      ...(status === 'error' &&
        errorCode !== undefined &&
        ERROR_CODE_PATTERN.test(errorCode) && { error_code: errorCode }),
      duration_ms: elapsedMs(startedAt),
      ...(handler && { handler_ms: handler.handlerMs }),
    };
  };
  const serverNameField = (serverName: string | undefined) => {
    const name = reporting?.serverName ?? serverName;
    return name !== undefined && SERVER_NAME_PATTERN.test(name) ? { server_name: name } : {};
  };
  const context: ToolCallContext = {
    connected: false,
    startToolCall(toolName, serverName, requestKey, protocolVersion) {
      if (!reporter || !reporting || !details) return undefined;
      if (reporting.tools) {
        try {
          if (!reporting.tools(toolName)) return undefined;
        } catch (error) {
          warnOnce(
            'tools-threw',
            `Clerk warning: ${caller} reporting.tools threw ${safeErrorName(error)}, so the call to ${TOOL_NAME_PATTERN.test(toolName) ? toolName : 'a tool'} was not reported`,
          );
          return undefined;
        }
      }
      if (!TOOL_NAME_PATTERN.test(toolName)) {
        warnOnce(
          'tool-name',
          `Clerk warning: ${caller} reports only tools named with 1 to 128 letters, digits, or any of _ . / -, so a call to a tool with another name was not reported`,
        );
        return undefined;
      }
      const occurredAt = Date.now();
      const startedAt = now();
      return (outcome) => {
        reporter.enqueue({
          type: 'tool_call',
          occurred_at: occurredAt,
          tool_name: toolName,
          ...serverNameField(serverName),
          ...protocolVersionField(protocolVersion),
          ...handledFields(outcome, takeHandler(requestKey), startedAt),
          ...details,
        });
      };
    },
    startRequest(serverName, requestKey) {
      if (!reporter || !details) return undefined;
      const occurredAt = Date.now();
      const startedAt = now();
      return (observed, outcome) => {
        const handler = takeHandler(requestKey);
        const fields = validRequestFields(observed);
        if (!fields) return;
        const handled =
          fields.type === 'resource_read' || fields.type === 'prompt_get'
            ? handledFields(outcome ?? { status: 'success' }, handler, startedAt)
            : {};
        reporter.enqueue({
          ...fields,
          occurred_at: occurredAt,
          ...serverNameField(serverName),
          ...handled,
          ...details,
        } as McpEvent);
      };
    },
    startHandler(requestKey) {
      const startedAt = now();
      return (thrown) => {
        if (!reporter) return;
        handlers.set(requestKey, {
          handlerMs: elapsedMs(startedAt),
          thrownErrorCode: thrown && thrownErrorCode(thrown.error),
        });
      };
    },
    flush: () => reporter?.flush() ?? Promise.resolve(),
  };
  contexts.set(authInfo, context);
  return context;
}

/**
 * The largest body, in bytes, read from a request that failed authentication for its JSON-RPC method and tool name. A
 * larger one is reported without them.
 */
export const AUTH_FAILURE_BODY_LIMIT = 64 * 1024;

/**
 * Why `clerkInstrumentHandler` answered a request with a 401, 403 or 421, and, for a 403, the auth info of the token
 * that lacked the scopes.
 */
export type AuthFailureAnswer = {
  failure: McpAuthFailure;
  status: number;
  authInfo: AuthInfo | undefined;
};

/**
 * Reports a request that failed authentication, with the JSON-RPC method and tool name of its first message when
 * `body` has them. Identity is sent only for the token of a 403, and only when Clerk verified it. It never throws, and
 * the adapter answers the request without waiting for it, so the answer is the same with reporting on or off, and
 * just as fast.
 * @param body - The parsed JSON body, or a promise of it from a copy of the request that the adapter started reading
 * before it answered, up to `AUTH_FAILURE_BODY_LIMIT` bytes
 * @returns A function that sends the waiting auth failures, for the adapter to keep the runtime alive with. It returns
 * `undefined` when another request is already sending them, so a burst of refused requests sends one batch. The
 * whole result is `undefined` when nothing was reported.
 */
export async function reportAuthFailure<Req>({
  caller,
  reporting,
  answer,
  body: bodyOrPromise,
  request,
  defaultIpAddress,
  userAgent,
  env,
}: {
  caller: string;
  reporting: ToolCallReporting<Req> | undefined;
  answer: AuthFailureAnswer;
  body: unknown;
  request: Req;
  defaultIpAddress: () => string | null | undefined;
  userAgent: () => string | null | undefined;
  env: { secretKey: string | undefined; apiUrl: string | undefined };
}): Promise<(() => Promise<void> | undefined) | undefined> {
  if (!reporting) return undefined;
  try {
    const reporter = reporterFor(caller, reporting, env);
    if (!reporter) return undefined;
    const occurredAt = Date.now();
    const { failure, status, authInfo } = answer;
    let body: unknown;
    try {
      body = await bodyOrPromise;
    } catch {}
    const first = (Array.isArray(body) ? body[0] : body) as
      | { method?: unknown; params?: { name?: unknown; _meta?: Record<string, unknown> } | null }
      | null
      | undefined;
    const method = typeof first?.method === 'string' ? first.method : undefined;
    const toolName =
      method === 'tools/call' && typeof first?.params?.name === 'string'
        ? first.params.name
        : undefined;
    const code = failure.cause?.code;
    const { serverName } = reporting;
    reporter.enqueue({
      type: 'auth_failure',
      occurred_at: occurredAt,
      ...(serverName !== undefined &&
        SERVER_NAME_PATTERN.test(serverName) && { server_name: serverName }),
      reason: failure.reason,
      http_status: status,
      // A verifier's code is an identifier, such as `token-expired`, never its message
      ...(typeof code === 'string' && VERIFIER_CODE_PATTERN.test(code) && { verifier_code: code }),
      ...(method !== undefined && METHOD_PATTERN.test(method) && { method }),
      ...(toolName !== undefined &&
        isReportedTool(caller, reporting, toolName) && { tool_name: toolName }),
      ...protocolVersionField(first?.params?._meta?.[PROTOCOL_VERSION_META_KEY]),
      ...requestDetails(
        caller,
        reporting,
        status === 403 ? authInfo : undefined,
        request,
        defaultIpAddress,
        userAgent,
      ),
    });
    return () => reporter.drainAuthFailures();
  } catch {
    return undefined;
  }
}

// Whether `reporting.tools` lets a tool's name be reported. A name the Backend API would refuse never is.
function isReportedTool<Req>(caller: string, reporting: ToolCallReporting<Req>, toolName: string) {
  if (!TOOL_NAME_PATTERN.test(toolName)) return false;
  if (!reporting.tools) return true;
  try {
    return reporting.tools(toolName);
  } catch (error) {
    warnOnce(
      'tools-threw',
      `Clerk warning: ${caller} reporting.tools threw ${safeErrorName(error)}, so an auth failure was reported without the name of ${toolName}`,
    );
    return false;
  }
}

/**
 * Warns once when a POST that reached the handler and succeeded never reached an instrumented server, the sign of a
 * server created without `clerkInstrumentServer`. A `subscriptions/listen` stream never connects a server.
 */
export function checkToolCallContext(
  caller: string,
  context: ToolCallContext | undefined,
  reporting: object | undefined,
  {
    method,
    status,
    mcpMethod,
  }: { method: string; status: number; mcpMethod: string | null | undefined },
) {
  if (!context || !reporting || context.connected) return;
  if (method !== 'POST' || status < 200 || status >= 300 || mcpMethod === 'subscriptions/listen')
    return;
  warnOnce(
    'not-instrumented',
    `Clerk warning: ${caller} reports tool calls only from servers passed to clerkInstrumentServer, and this request's server was not. Call clerkInstrumentServer(server) where each MCP server is created`,
  );
}

/**
 * Warns once when an instrumented server gets a tool call with auth info that did not come from
 * `clerkInstrumentHandler`, such as from `mcpAuth`.
 */
export function warnOutsideInstrumentHandler() {
  warnOnce(
    'outside-handler',
    'Clerk warning: clerkInstrumentServer only sees tool calls that clerkInstrumentHandler authenticated. Serve this MCP server through clerkInstrumentHandler(handler, options) in place of mcpAuth or withClerkMcpAuth',
  );
}

function requestDetails<Req>(
  caller: string,
  reporting: ToolCallReporting<Req>,
  authInfo: AuthInfo | undefined,
  request: Req,
  defaultIpAddress: () => string | null | undefined,
  userAgent: () => string | null | undefined,
): RequestDetails {
  const details: RequestDetails = {};
  if (
    reporting.identity &&
    authInfo &&
    hasClerkVerification(authInfo) &&
    authInfo.extra?.verifiedBy === 'clerk'
  ) {
    const { userId, auth } = authInfo.extra as {
      userId?: unknown;
      auth?: { id?: unknown; orgId?: unknown };
    };
    if (typeof userId === 'string' && USER_ID_PATTERN.test(userId)) details.user_id = userId;
    if (ID_PATTERN.test(authInfo.clientId)) details.client_id = authInfo.clientId;
    if (typeof auth?.id === 'string' && ID_PATTERN.test(auth.id)) {
      details.oauth_access_token_id = auth.id;
    }
    if (typeof auth?.orgId === 'string' && ORG_ID_PATTERN.test(auth.orgId)) {
      details.org_id = auth.orgId;
    }
  }
  if (reporting.ipAddress) {
    let address: string | null | undefined;
    try {
      address =
        typeof reporting.ipAddress === 'function'
          ? reporting.ipAddress(request)
          : defaultIpAddress();
    } catch (error) {
      warnOnce(
        'ip-address-threw',
        `Clerk warning: ${caller} reporting.ipAddress threw ${safeErrorName(error)}, so no IP address was reported`,
      );
    }
    const ipAddress = normalizeIpAddress(address);
    if (ipAddress) details.ip_address = ipAddress;
  }
  if (reporting.userAgent) {
    const agent = userAgent()?.trim();
    if (agent) details.user_agent = agent.slice(0, MAX_USER_AGENT_LENGTH);
  }
  return details;
}

/**
 * The address in the form the Backend API accepts: an IPv4-mapped IPv6 address, which Node.js reports for IPv4
 * clients of a dual-stack socket, as its IPv4 address. Anything else that is not an IP address is `undefined`.
 */
export function normalizeIpAddress(address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined;
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed)?.[1];
  const candidate = mapped ?? trimmed;
  return IPV4_PATTERN.test(candidate) || IPV6_PATTERN.test(candidate) ? candidate : undefined;
}

type Reporter = {
  enqueue(event: McpEvent): void;
  flush(): Promise<void>;
  /**
   * Sends the waiting auth failures after a short wait that gathers a burst into one batch, or returns `undefined`
   * when a call before it is already doing so.
   */
  drainAuthFailures(): Promise<void> | undefined;
  pending(): number;
};

const reporters = new Map<typeof fetch | undefined, Map<string, Reporter>>();

function reporterFor<Req>(
  caller: string,
  reporting: ToolCallReporting<Req>,
  env: { secretKey: string | undefined; apiUrl: string | undefined },
): Reporter | undefined {
  const secretKey = reporting.secretKey ?? env.secretKey;
  const apiUrl = reporting.apiUrl ?? (env.apiUrl || undefined);
  if (!secretKey?.trim()) {
    warnOnce(
      'secret-key',
      `Clerk warning: ${caller} needs the CLERK_SECRET_KEY environment variable or reporting.secretKey to report tool calls, so they are not reported`,
    );
    return undefined;
  }
  const byKey = reporters.get(reporting.fetch) ?? new Map<string, Reporter>();
  reporters.set(reporting.fetch, byKey);
  const cacheKey = JSON.stringify([secretKey, apiUrl ?? null]);
  const cached = byKey.get(cacheKey);
  if (cached) return cached;
  let reporter: Reporter;
  try {
    reporter = createReporter(
      caller,
      createBackendApiClient(caller, { secretKey, apiUrl, fetch: reporting.fetch }),
    );
  } catch {
    warnOnce(
      'api-url',
      `Clerk warning: ${caller} cannot report tool calls because CLERK_API_URL does not use HTTPS or loopback HTTP`,
    );
    return undefined;
  }
  byKey.set(cacheKey, reporter);
  return reporter;
}

function createReporter(
  caller: string,
  client: ReturnType<typeof createBackendApiClient>,
): Reporter {
  const queue: McpEvent[] = [];
  const authFailures: McpEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;
  let authWindowStart = 0;
  let authWindowCount = 0;
  let draining: Promise<void> | undefined;
  const pending = () => queue.length + authFailures.length;

  async function send(batch: McpEvent[]) {
    try {
      const response = await client.post(EVENTS_PATH, { sdk: SDK, events: batch });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        warnOnce(
          `status-${response.status}`,
          `Clerk warning: ${caller} could not report ${batch.length} MCP events to Clerk, which answered with status ${response.status}${STATUS_HINTS[response.status] ?? ''}`,
        );
      }
    } catch (error) {
      warnOnce(
        `send-${safeErrorName(error)}`,
        `Clerk warning: ${caller} could not report ${batch.length} MCP events to Clerk: ${safeErrorName(error)}`,
      );
    }
  }

  function schedule() {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, FLUSH_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  // Each call takes its own batches and awaits only its own requests: on Cloudflare Workers, a request must not wait
  // on I/O that another request started. While MAX_IN_FLIGHT batches are being sent, events wait in the queue, which
  // drops its oldest once full, so a Backend API that stops answering cannot grow memory without bound.
  async function flush() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (pending() > 0 && inFlight < MAX_IN_FLIGHT) {
      inFlight++;
      try {
        const batch = queue.splice(0, MAX_BATCH_SIZE);
        batch.push(...authFailures.splice(0, MAX_BATCH_SIZE - batch.length));
        await send(batch);
      } finally {
        inFlight--;
      }
    }
    if (pending() > 0) schedule();
  }

  function enqueueAuthFailure(event: McpEvent) {
    const now = Date.now();
    if (now - authWindowStart >= AUTH_FAILURE_WINDOW_MS) {
      authWindowStart = now;
      authWindowCount = 0;
    }
    if (authWindowCount >= MAX_AUTH_FAILURES_PER_WINDOW) {
      warnOnce(
        'auth-failure-rate',
        `Clerk warning: ${caller} reports at most ${MAX_AUTH_FAILURES_PER_WINDOW} auth failures a minute, so it dropped some`,
      );
      return;
    }
    authWindowCount++;
    if (authFailures.length >= MAX_QUEUED_AUTH_FAILURES) authFailures.shift();
    authFailures.push(event);
    schedule();
  }

  const reporter: Reporter = {
    enqueue(event) {
      if (event.type === 'auth_failure') {
        enqueueAuthFailure(event);
        return;
      }
      if (queue.length >= MAX_QUEUED) {
        queue.shift();
        warnOnce(
          'queue-full',
          `Clerk warning: ${caller} dropped the oldest MCP events waiting to be sent, because ${MAX_QUEUED} were already waiting`,
        );
      }
      queue.push(event);
      if (queue.length >= MAX_BATCH_SIZE && inFlight < MAX_IN_FLIGHT) {
        void flush();
        return;
      }
      schedule();
    },
    flush,
    // One caller at a time waits, then sends until no auth failure is left, all from its own context: on Cloudflare
    // Workers its `waitUntil` keeps the timer and the requests alive, and no request waits on another's I/O
    drainAuthFailures() {
      if (draining) return undefined;
      draining = (async () => {
        await new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS));
        while (authFailures.length > 0 && inFlight < MAX_IN_FLIGHT) await flush();
      })().finally(() => {
        draining = undefined;
      });
      return draining;
    },
    pending,
  };
  flushBeforeExit(reporter);
  return reporter;
}

const exitingReporters = new Set<Reporter>();

// The flush timer does not keep Node.js running, so reports still waiting when the event loop empties are sent then
function flushBeforeExit(reporter: Reporter) {
  if (typeof process === 'undefined' || typeof process.on !== 'function') return;
  if (exitingReporters.size === 0) {
    process.on('beforeExit', () => {
      for (const waiting of exitingReporters) if (waiting.pending() > 0) void waiting.flush();
    });
  }
  exitingReporters.add(reporter);
}

/**
 * The outcome of a JSON-RPC response to `tools/call`: an error response, a result with `isError`, which reports the
 * code in `_meta[ERROR_CODE_META_KEY]` when it has one, or a success.
 */
export function toolCallOutcome(message: { result?: unknown; error?: unknown }): ToolCallOutcome {
  if (message.error !== undefined) {
    const code = (message.error as { code?: unknown } | null)?.code;
    return {
      status: 'error',
      errorCode: Number.isInteger(code) ? `jsonrpc:${code as number}` : undefined,
    };
  }
  const result = message.result as { isError?: unknown; _meta?: Record<string, unknown> } | null;
  if (result?.isError !== true) return { status: 'success' };
  const code = result._meta?.[ERROR_CODE_META_KEY];
  return { status: 'error', errorCode: typeof code === 'string' ? code : undefined };
}

/**
 * Calls `onEnd` once the response's body has been sent or abandoned, or right away for a response without one.
 * @returns The response to send in place of `response`
 */
export function onResponseEnd(response: Response, onEnd: () => void): Response {
  if (!response.body) {
    onEnd();
    return response;
  }
  const { readable, writable } = new TransformStream();
  void response.body
    .pipeTo(writable)
    .catch(() => undefined)
    .then(() => {
      try {
        onEnd();
      } catch {}
    });
  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
