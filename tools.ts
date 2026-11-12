/**
 * Prebuilt MCP tools backed by a Clerk instance: `submitFeedbackTool` lets agents report friction to the Clerk
 * Dashboard, and `createBrowserSessionTool` gives agents a one-time link that opens your app signed in as the user.
 * Register either with `server.registerTool(...tool)` on MCP SDK 1.x or 2.x.
 *
 * @module
 */
export {
  type BrowserSession,
  type BrowserSessionErrorCode,
  type CreateBrowserSessionOptions,
  type CreateBrowserSessionRequest,
  type CreateBrowserSessionTool,
  type CreateBrowserSessionToolOptions,
  BrowserSessionError,
  CREATE_BROWSER_SESSION_TOOL_NAME,
  browserSessionInstructions,
  createBrowserSession,
  createBrowserSessionTool,
} from './create-browser-session';
export {
  type FeedbackImpact,
  type FeedbackKind,
  type FeedbackOrigin,
  type FeedbackReport,
  type SubmitFeedbackOptions,
  type SubmitFeedbackTool,
  type SubmitFeedbackToolOptions,
  type SubmittedFeedback,
  FeedbackSubmissionError,
  SUBMIT_FEEDBACK_TOOL_NAME,
  submitFeedback,
  submitFeedbackTool,
} from './feedback';
