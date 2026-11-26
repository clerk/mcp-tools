// The `ui://` URIs `mcpAppViewResource` has built views for in this process, which `publicAccess.views` opens without
// a token, and whether an `mcpAuth` with `views` on has checked a request yet. Both live on `globalThis` under
// registered symbols, so `./tools` and the adapters share them even when a bundler loads this module more than once,
// and so does every copy of the package in the process: keep the view holder a `Set<string>` and the other a
// `boolean` in every version. The set is never cleared: a view stays open after its resource is removed, and in every
// server of the process, until the process ends. This module is not a package entry point.

const APP_VIEW_URIS: unique symbol = Symbol.for('@clerk/mcp-tools/app-view-uris');
const VIEWS_CHECKED: unique symbol = Symbol.for('@clerk/mcp-tools/app-views-checked');

type AppViewHolder = { [APP_VIEW_URIS]?: Set<string>; [VIEWS_CHECKED]?: boolean };

const holder = globalThis as AppViewHolder;

function appViewUris(): Set<string> {
  holder[APP_VIEW_URIS] ??= new Set();
  return holder[APP_VIEW_URIS];
}

/**
 * Records the URI of a view `mcpAppViewResource` built, so `publicAccess.views` can open it.
 * @param uri - The view's `ui://` URI, already checked
 * @returns `true` when the URI is new and an `mcpAuth` with `views` on had already checked a request, which a read of
 * this view without a token, if any, got the 401 for
 */
export function registerAppView(uri: string): boolean {
  const uris = appViewUris();
  if (uris.has(uri)) return false;
  uris.add(uri);
  return holder[VIEWS_CHECKED] === true;
}

/**
 * Notes that an `mcpAuth` or `withClerkMcpAuth` with `views` on is checking a request, so a view built afterward is
 * known to be late.
 */
export function noteViewsChecked(): void {
  holder[VIEWS_CHECKED] = true;
}

/**
 * Whether `uri` is exactly the URI of a view `mcpAppViewResource` built in this process.
 * @param uri - The URI a request asks for, unchecked
 * @returns `true` for a registered view's URI
 */
export function isAppView(uri: unknown): boolean {
  return typeof uri === 'string' && appViewUris().has(uri);
}
