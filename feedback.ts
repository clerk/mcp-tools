import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

import {
  type BackendApiOptions,
  type McpToolTuple,
  OPEN_WORLD_WRITE_ANNOTATIONS,
  postBackendApi,
  validateBackendApiOptions,
} from './backend-api';
import { isClerkAuthInfo } from './server';

export const SUBMIT_FEEDBACK_TOOL_NAME = 'submit_feedback';

export const FEEDBACK_KINDS = ['missing', 'broken', 'confusing', 'idea'] as const;

export const FEEDBACK_IMPACTS = ['blocked', 'worked_around', 'friction'] as const;

export const SUBMIT_FEEDBACK_DESCRIPTION = [
  'Report a problem you ran into while doing a task for the user, so the team that runs this MCP server can fix it.',
  'Call it once per task, after you finish or give up, whenever: none of these tools could do what the task needed (the most useful kind of report); a tool failed or returned something wrong or inconsistent; a tool or its documentation was confusing; or the user asks you to report something.',
  'You do not need to ask the user first.',
  'Never include secrets, API keys, tokens, or personal data about end users.',
  'Reports are read by the team that runs this server.',
].join(' ');

export const submitFeedbackInputSchema = {
  kind: z
    .enum(FEEDBACK_KINDS)
    .describe(
      'What kind of problem: "missing" (no tool could do what the task needed), "broken" (a tool failed or returned something wrong), "confusing" (a tool or its documentation was unclear), or "idea" (a suggestion that would have helped).',
    ),
  task: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'A short phrase naming what the user asked you to do, such as "Add an organization switcher".',
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe(
      'What you tried, including each tool call you made, and what went wrong or was confusing. Include both.',
    ),
  impact: z
    .enum(FEEDBACK_IMPACTS)
    .describe(
      'How the task ended: "blocked" (could not finish), "worked_around" (finished another way), or "friction" (finished, but it was harder than it should be).',
    ),
  operation: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe(
      'Name of the tool the problem is about, such as create_user. Omit it when no tool was involved.',
    ),
  error: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .describe('The exact error you received, with any secrets removed.'),
  suggestion: z.string().trim().max(2000).optional().describe('What would have helped.'),
};

const submitFeedbackOutputSchema = {
  feedback_id: z.string(),
  received: z.boolean(),
};

export type FeedbackOrigin = { type: string; name?: string; version?: string };

/** One feedback report, shared by every kind of reporter (MCP servers, apps, CLIs). */
export type FeedbackReport = {
  /** Known values: missing, broken, confusing, idea. Other lowercase slugs are stored as-is. */
  kind: string;
  task: string;
  description: string;
  /** Known values: blocked, worked_around, friction. Other lowercase slugs are stored as-is. */
  impact?: string;
  operation?: string;
  error?: string;
  suggestion?: string;
  tags?: string[];
  source?: FeedbackOrigin;
  reporter?: Partial<FeedbackOrigin>;
  user_id?: string;
  client_id?: string;
  metadata?: Record<string, unknown>;
};

export type SubmitFeedbackOptions = BackendApiOptions & {
  /** Secret key of the Clerk instance the feedback belongs to. */
  secretKey: string;
};

export type SubmitFeedbackToolOptions = SubmitFeedbackOptions & {
  /** Name and version of your MCP server, shown with each report. The name defaults to the request's host. */
  server?: { name?: string; version?: string };
};

export type SubmittedFeedback = { id: string; created_at: string };

export class FeedbackSubmissionError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Clerk rejected the feedback with status ${status}`);
    this.name = 'FeedbackSubmissionError';
  }
}

/**
 * Stores feedback on the Clerk instance that owns `secretKey`, where it shows up in the Clerk Dashboard.
 */
export async function submitFeedback(
  report: FeedbackReport,
  options: SubmitFeedbackOptions,
): Promise<SubmittedFeedback> {
  const response = await postBackendApi('/v1/feedback', report, options);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isSubmittedFeedback(body)) {
    throw new FeedbackSubmissionError(response.status, body);
  }
  return body;
}

function isSubmittedFeedback(body: unknown): body is SubmittedFeedback {
  return (
    typeof body === 'object' &&
    body !== null &&
    'id' in body &&
    typeof body.id === 'string' &&
    'created_at' in body &&
    typeof body.created_at === 'string'
  );
}

// MCP clients often show agents namespaced tool names (Claude Code uses mcp__<server>__<tool>), and agents
// sometimes list several; store the names this server registered, within the Backend API's limit.
function bareToolNames(operation: string) {
  return operation
    .replace(/\bmcp__[^_\s,/]+(?:_[^_\s,/]+)*?__/g, '')
    .slice(0, MAX_OPERATION_LENGTH);
}

type SubmitFeedbackToolCallback = ToolCallback<typeof submitFeedbackInputSchema>;
type ToolExtra = Parameters<SubmitFeedbackToolCallback>[1];

/** Arguments for `McpServer.registerTool`. */
export type SubmitFeedbackTool = McpToolTuple<
  typeof SUBMIT_FEEDBACK_TOOL_NAME,
  typeof submitFeedbackInputSchema,
  typeof submitFeedbackOutputSchema
>;

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

// The Backend API rejects longer values, which would lose the whole report.
const MAX_NAME_LENGTH = 100;
const MAX_VERSION_LENGTH = 50;
const MAX_OPERATION_LENGTH = 200;

// HTTP libraries and browsers, which say nothing about which agent is calling.
const GENERIC_USER_AGENTS = new Set([
  'axios',
  'bun',
  'curl',
  'deno',
  'go-http-client',
  'mozilla',
  'node',
  'node-fetch',
  'okhttp',
  'python-httpx',
  'python-requests',
  'python-urllib',
  'undici',
]);

function label(value: unknown, maxLength: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function origin(type: string, name: unknown, version: unknown): FeedbackOrigin {
  return { type, name: label(name, MAX_NAME_LENGTH), version: label(version, MAX_VERSION_LENGTH) };
}

function clientInfoFromMeta(meta: RequestMeta | undefined) {
  const info = meta?.[CLIENT_INFO_META_KEY];
  if (
    !info ||
    typeof info !== 'object' ||
    !('name' in info) ||
    !label(info.name, MAX_NAME_LENGTH)
  ) {
    return undefined;
  }
  return { name: info.name, version: 'version' in info ? info.version : undefined };
}

// Clients that don't send their info with each request are named by their User-Agent product token,
// such as "claude-code/2.1.0".
function clientInfoFromUserAgent(
  headers: NonNullable<ToolExtra['requestInfo']>['headers'] | undefined,
) {
  const header = headers?.['user-agent'];
  const userAgent = Array.isArray(header) ? header[0] : header;
  const product = userAgent?.trim().split(/\s+/)[0];
  if (!product) {
    return undefined;
  }
  const [name, version] = product.split('/', 2);
  if (!name || GENERIC_USER_AGENTS.has(name.toLowerCase())) {
    return undefined;
  }
  return { name, version };
}

function reporter(extra: ToolExtra): FeedbackOrigin {
  const client =
    clientInfoFromMeta(extra._meta) ?? clientInfoFromUserAgent(extra.requestInfo?.headers);
  return origin('agent', client?.name, client?.version);
}

function source(extra: ToolExtra, server: SubmitFeedbackToolOptions['server']): FeedbackOrigin {
  return origin(
    'mcp',
    label(server?.name, MAX_NAME_LENGTH) ?? extra.requestInfo?.url?.host,
    server?.version,
  );
}

// Custom mcpAuth verifiers can fill AuthInfo from other identity providers; only forward
// identity that verifyClerkToken produced.
function identityFromAuthInfo(authInfo: AuthInfo | undefined) {
  return isClerkAuthInfo(authInfo)
    ? { user_id: authInfo.extra.userId, client_id: authInfo.clientId || undefined }
    : {};
}

// After a timeout, a lost connection, or an unreadable 2xx response, Clerk may already have stored the report.
function wasRejected(error: unknown): error is FeedbackSubmissionError {
  return error instanceof FeedbackSubmissionError && (error.status < 200 || error.status >= 300);
}

// Only the status or error name: a custom fetch's error message could echo the Authorization header.
function failureReason(error: unknown) {
  if (error instanceof FeedbackSubmissionError) {
    return `status ${error.status}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

function toolError(text: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${text} Do not retry; continue with the task.` }],
  };
}

/**
 * Builds a `submit_feedback` tool that agents call when they hit friction. Register it with
 * `server.registerTool(...submitFeedbackTool({ secretKey }))`. Feedback is stored on the Clerk instance that
 * owns `secretKey` and is visible in the Clerk Dashboard. When the request was authenticated with
 * `verifyClerkToken`, the user and OAuth client ids are attached automatically.
 */
export function submitFeedbackTool(options: SubmitFeedbackToolOptions): SubmitFeedbackTool {
  validateBackendApiOptions('submitFeedbackTool', options);

  const callback: SubmitFeedbackToolCallback = async (input, extra) => {
    try {
      const { id } = await submitFeedback(
        {
          ...input,
          operation: input.operation && bareToolNames(input.operation),
          source: source(extra, options.server),
          reporter: reporter(extra),
          ...identityFromAuthInfo(extra.authInfo),
        },
        options,
      );
      const result = { feedback_id: id, received: true };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const reason = failureReason(error);
      if (!wasRejected(error)) {
        console.error(
          `Clerk error: submit_feedback could not confirm the feedback was stored (${reason})`,
        );
        return toolError('Feedback may not have been received.');
      }
      console.error(`Clerk error: submit_feedback could not store feedback (${reason})`);
      if (error.status === 429) {
        return toolError('Feedback limit reached for now.');
      }
      return toolError('Feedback could not be sent.');
    }
  };

  return [
    SUBMIT_FEEDBACK_TOOL_NAME,
    {
      title: 'Send feedback',
      description: SUBMIT_FEEDBACK_DESCRIPTION,
      inputSchema: submitFeedbackInputSchema,
      outputSchema: submitFeedbackOutputSchema,
      annotations: OPEN_WORLD_WRITE_ANNOTATIONS,
    },
    callback,
  ];
}
