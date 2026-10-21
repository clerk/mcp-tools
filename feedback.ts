import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod/v4';

import { isClerkAuthInfo } from './server';

const DEFAULT_API_URL = 'https://api.clerk.com';

export const SUBMIT_FEEDBACK_TOOL_NAME = 'submit_feedback';

export const FEEDBACK_OUTCOMES = ['blocked', 'worked_around', 'succeeded_with_friction'] as const;

export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export const SUBMIT_FEEDBACK_DESCRIPTION = [
  'Send feedback to the team that runs this MCP server about a problem you hit while working for the user.',
  'Call this when a task fails, needed a workaround, a tool returned a confusing or wrong result, documentation was missing, or the user asks you to report a problem.',
  'Never include secrets, API keys, tokens, or personal data about end users.',
  'Reports are read by the team that runs this server and used to improve it.',
].join(' ');

export const submitFeedbackInputSchema = {
  goal: z.string().trim().min(1).max(2000).describe('What the user asked you to accomplish.'),
  attempted: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe('The steps you took and the tool calls you made.'),
  outcome: z
    .enum(FEEDBACK_OUTCOMES)
    .describe(
      'How it ended: "blocked" (could not finish), "worked_around" (finished with a workaround), or "succeeded_with_friction" (finished but it was harder than it should be).',
    ),
  issue: z.string().trim().min(1).max(4000).describe('What went wrong or was confusing.'),
  tool_name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe(
      'Name of the tool the problem is about, such as create_user. Omit it when no tool was involved.',
    ),
  error_text: z
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

export type FeedbackInput = {
  goal: string;
  attempted: string;
  outcome: FeedbackOutcome;
  issue: string;
  tool_name?: string;
  error_text?: string;
  suggestion?: string;
};

export type SubmitFeedbackOptions = {
  /** Secret key of the Clerk instance the feedback belongs to. */
  secretKey: string;
  /** Origin of the Clerk Backend API. Defaults to https://api.clerk.com. */
  apiUrl?: string;
  fetch?: typeof fetch;
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
  input: FeedbackInput & { user_id?: string; oauth_client_id?: string },
  { secretKey, apiUrl = DEFAULT_API_URL, fetch: fetchImpl = fetch }: SubmitFeedbackOptions,
): Promise<SubmittedFeedback> {
  const response = await fetchImpl(new URL('/v1/agent_feedback', apiUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
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

// Custom mcpAuth verifiers can fill AuthInfo from other identity providers; only forward
// identity that verifyClerkToken produced.
function identityFromAuthInfo(authInfo: AuthInfo | undefined) {
  const userId = authInfo?.extra?.userId;
  if (!isClerkAuthInfo(authInfo) || typeof userId !== 'string') {
    return {};
  }
  return { user_id: userId, oauth_client_id: authInfo?.clientId || undefined };
}

/**
 * Registers a `submit_feedback` tool that agents call when they hit friction. Feedback is stored on the
 * Clerk instance that owns `secretKey` and is visible in the Clerk Dashboard. When the request was
 * authenticated with `verifyClerkToken`, the user and OAuth client ids are attached automatically.
 */
export function registerSubmitFeedbackTool(server: McpServer, options: SubmitFeedbackOptions) {
  if (!options.secretKey) {
    throw new Error(
      'Clerk error: registerSubmitFeedbackTool requires the secretKey of a Clerk instance',
    );
  }
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
        const { id } = await submitFeedback(
          { ...input, ...identityFromAuthInfo(extra.authInfo) },
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
