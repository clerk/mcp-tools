// The `ui://` URIs `mcpAppViewResource` has built views for in this process, which `publicAccess.views` opens without
// a token. It lives on `globalThis` under a registered symbol, so `./tools` and the adapters share one set even when a
// bundler loads this module more than once. This module is not a package entry point.

const APP_VIEW_URIS: unique symbol = Symbol.for('@clerk/mcp-tools/app-view-uris');

type AppViewHolder = { [APP_VIEW_URIS]?: Set<string> };

function appViewUris(): Set<string> {
  const holder = globalThis as AppViewHolder;
  holder[APP_VIEW_URIS] ??= new Set();
  return holder[APP_VIEW_URIS];
}

/**
 * Records the URI of a view `mcpAppViewResource` built, so `publicAccess.views` can open it.
 * @param uri - The view's `ui://` URI, already checked
 */
export function registerAppView(uri: string): void {
  appViewUris().add(uri);
}

/**
 * Whether `uri` is exactly the URI of a view `mcpAppViewResource` built in this process.
 * @param uri - The URI a request asks for, unchecked
 * @returns `true` for a registered view's URI
 */
export function isAppView(uri: unknown): boolean {
  return typeof uri === 'string' && appViewUris().has(uri);
}
