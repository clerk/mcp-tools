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
  BrowserSessionError,
  browserSessionInstructions,
  createBrowserSession,
  createBrowserSessionTool,
} from './create-browser-session';
export {
  type FeedbackOrigin,
  type FeedbackReport,
  type SubmitFeedbackOptions,
  type SubmitFeedbackTool,
  type SubmitFeedbackToolOptions,
  type SubmittedFeedback,
  FeedbackSubmissionError,
  submitFeedback,
  submitFeedbackTool,
} from './feedback';
