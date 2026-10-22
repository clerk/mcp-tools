import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Implementation, RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

import { isClerkAuthInfo } from './server';

const DEFAULT_API_URL = 'https://api.clerk.com';

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
    .max(200)
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

export type SubmitFeedbackOptions = {
  /** Secret key of the Clerk instance the feedback belongs to. */
  secretKey: string;
  /** Origin of the Clerk Backend API. Defaults to https://api.clerk.com. */
  apiUrl?: string;
  fetch?: typeof fetch;
};

export type RegisterSubmitFeedbackToolOptions = SubmitFeedbackOptions & {
  /** Name and version of your MCP server, shown with each report. */
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
  { secretKey, apiUrl = DEFAULT_API_URL, fetch: fetchImpl = fetch }: SubmitFeedbackOptions,
): Promise<SubmittedFeedback> {
  const response = await fetchImpl(new URL('/v1/feedback', apiUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(report),
  });
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
// sometimes list several; store the names this server registered.
function bareToolNames(operation: string) {
  return operation.replace(/\bmcp__[^_\s,/]+(?:_[^_\s,/]+)*?__/g, '');
}

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

function clientInfoFromMeta(meta: RequestMeta | undefined): Implementation | undefined {
  const info = meta?.[CLIENT_INFO_META_KEY];
  if (!info || typeof info !== 'object' || !('name' in info) || typeof info.name !== 'string') {
    return undefined;
  }
  const version = 'version' in info && typeof info.version === 'string' ? info.version : '';
  return { name: info.name, version };
}

// A server shared across stateless HTTP requests keeps the client info of whichever client initialized last.
// Connections to one server are sequential, so that info belongs to the current connection only if it changed
// after this connection opened.
function trackInitializingClients(server: McpServer) {
  const lowLevel = server.server;
  const clientBeforeConnect = new WeakMap<Transport, Implementation | undefined>();
  const connect = lowLevel.connect.bind(lowLevel);
  lowLevel.connect = (transport) => {
    clientBeforeConnect.set(transport, lowLevel.getClientVersion());
    return connect(transport);
  };
  return function currentClient(meta: RequestMeta | undefined): Implementation | undefined {
    const fromRequest = clientInfoFromMeta(meta);
    if (fromRequest) {
      return fromRequest;
    }
    const transport = lowLevel.transport;
    if (!transport || !clientBeforeConnect.has(transport)) {
      return undefined;
    }
    const client = lowLevel.getClientVersion();
    return client === clientBeforeConnect.get(transport) ? undefined : client;
  };
}

// Custom mcpAuth verifiers can fill AuthInfo from other identity providers; only forward
// identity that verifyClerkToken produced.
function identityFromAuthInfo(authInfo: AuthInfo | undefined) {
  const userId = authInfo?.extra?.userId;
  if (!isClerkAuthInfo(authInfo) || typeof userId !== 'string') {
    return {};
  }
  return { user_id: userId, client_id: authInfo?.clientId || undefined };
}

/**
 * Registers a `submit_feedback` tool that agents call when they hit friction. Feedback is stored on the
 * Clerk instance that owns `secretKey` and is visible in the Clerk Dashboard. When the request was
 * authenticated with `verifyClerkToken`, the user and OAuth client ids are attached automatically, and the
 * connected agent's name and version are attached when the client sent them.
 */
export function registerSubmitFeedbackTool(
  server: McpServer,
  options: RegisterSubmitFeedbackToolOptions,
) {
  if (!options.secretKey) {
    throw new Error(
      'Clerk error: registerSubmitFeedbackTool requires the secretKey of a Clerk instance',
    );
  }
  const currentClient = trackInitializingClients(server);
  return server.registerTool<typeof submitFeedbackOutputSchema, typeof submitFeedbackInputSchema>(
    SUBMIT_FEEDBACK_TOOL_NAME,
    {
      title: 'Send feedback',
      description: SUBMIT_FEEDBACK_DESCRIPTION,
      inputSchema: submitFeedbackInputSchema,
      outputSchema: submitFeedbackOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        const client = currentClient(extra._meta);
        const { id } = await submitFeedback(
          {
            ...input,
            operation: input.operation && bareToolNames(input.operation),
            source: { type: 'mcp', ...options.server },
            reporter: { type: 'agent', name: client?.name, version: client?.version || undefined },
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
        const status = error instanceof FeedbackSubmissionError ? error.status : undefined;
        // Only the status or error name: a custom fetch's error message could echo the Authorization header.
        const reason = status
          ? `status ${status}`
          : error instanceof Error
            ? error.name
            : 'unknown error';
        console.error(`Clerk error: submit_feedback could not store feedback (${reason})`);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                status === 429
                  ? 'Feedback limit reached for now. Do not retry; continue with the task.'
                  : 'Feedback could not be sent. Do not retry; continue with the task.',
            },
          ],
        };
      }
    },
  );
}
