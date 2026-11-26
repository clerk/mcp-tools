// MCP App views: the `ui://` resources an MCP Apps host renders tool results in (MCP Apps 2026-01-26).
// Built without `@modelcontextprotocol/ext-apps`, so a server needs no package besides its MCP SDK.
import { registerAppView } from './app-view-registry';
import { assertKnownKeys, type Fail, failFor, isPlainObject } from './discovery-options';

/**
 * The media type MCP Apps 2026-01-26 gives a view (UIResource): its `mimeType` "SHOULD be `text/html;profile=mcp-app`
 * for HTML-based UIs in the initial MVP".
 */
const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

const CSP_KEYS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;

type CspKey = (typeof CSP_KEYS)[number];

/**
 * The origins a view may reach, as the `_meta.ui.csp` of MCP Apps 2026-01-26. The host builds the view's Content
 * Security Policy from them, and an empty or omitted list allows none. Each entry is an origin such as
 * `https://cdn.example.com`, or `https://*.example.com` for its subdomains: `*` and a bare scheme such as `https:`,
 * which would allow every origin, are rejected.
 */
type McpAppViewCsp = {
  /**
   * Origins for `fetch`, XHR, and WebSocket requests: CSP `connect-src`.
   */
  connectDomains?: readonly string[] | undefined;
  /**
   * Origins for images, scripts, stylesheets, fonts, and media: CSP `img-src`, `script-src`, and the rest.
   */
  resourceDomains?: readonly string[] | undefined;
  /**
   * Origins for nested iframes: CSP `frame-src`.
   */
  frameDomains?: readonly string[] | undefined;
  /**
   * Origins the document's `<base>` may point at: CSP `base-uri`.
   */
  baseUriDomains?: readonly string[] | undefined;
};

/**
 * Options for `mcpAppViewResource`.
 */
export type McpAppViewResourceOptions = {
  /**
   * The resource's name in `resources/list`.
   */
  name: string;
  /**
   * The view's URI, which MCP Apps requires to use the `ui://` scheme, such as `ui://my-server/user-card.html`.
   */
  uri: `ui://${string}`;
  /**
   * The view's HTML5 document. It should start with `<!DOCTYPE html>` and declare
   * `<meta name="color-scheme" content="light dark">` so it follows the host's theme. A Clerk secret key in it would be
   * published to anyone who can read the view.
   */
  html: string;
  /**
   * A human-readable title for `resources/list`.
   */
  title?: string | undefined;
  /**
   * What the view shows, for `resources/list`.
   */
  description?: string | undefined;
  /**
   * The origins the view may reach. Left out, or with every list empty, the host allows none. Name its type as
   * `McpAppViewResourceOptions['csp']`.
   */
  csp?: McpAppViewCsp | undefined;
  /**
   * Whether the host should draw a border and background around the view. Left out, the host decides.
   */
  prefersBorder?: boolean | undefined;
};

/**
 * The `_meta.ui` of a view's `resources/read` content item.
 */
type McpAppViewUiMeta = {
  csp?: Partial<Record<CspKey, string[]>>;
  prefersBorder?: boolean;
};

/**
 * Arguments for `McpServer.registerResource`, on MCP SDK v1 and v2: the view's name, URI, listing metadata, and the
 * read callback that returns its HTML.
 */
type McpAppViewResource = [
  name: string,
  uri: string,
  config: { title?: string; description?: string; mimeType: typeof MCP_APP_MIME_TYPE },
  readCallback: () => Promise<{
    contents: {
      uri: string;
      mimeType: typeof MCP_APP_MIME_TYPE;
      text: string;
      _meta?: { ui: McpAppViewUiMeta };
    }[];
  }>,
];

const optionKeys: ReadonlySet<string> = new Set<keyof McpAppViewResourceOptions>([
  'name',
  'uri',
  'html',
  'title',
  'description',
  'csp',
  'prefersBorder',
]);
const cspKeys: ReadonlySet<string> = new Set(CSP_KEYS);

// `scheme://host[:port]`, where the host may start with `*.` for its subdomains. No path, and no bare `*` or scheme.
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

// The views whose template warning was logged, so a server factory that runs for every request logs it once
const warnedUris = new Set<string>();

const CALLER = 'mcpAppViewResource';
const fail: Fail = failFor(CALLER);

/**
 * An MCP App view (MCP Apps 2026-01-26) as arguments for `server.registerResource(...view)`, on MCP SDK 1.x or
 * 2.x. A `resources/read` of its URI returns the HTML as `text/html;profile=mcp-app`, with the CSP and
 * `prefersBorder` in the content item's `_meta.ui`, where hosts read them. A CSP whose every list is empty is
 * left out, which the spec treats the same. Building it records the URI, so `publicAccess.views` of `mcpAuth` and
 * `withClerkMcpAuth` can open this view, and only views built here, without a token. Build it once at module scope,
 * not inside the server factory, so the URI is recorded before the first request arrives: a view first built after
 * an `mcpAuth` with `views` on checked a request logs a one-time `Clerk warning:`. The record is for the whole
 * process, so every server in it opens the view, and it stays after the resource is removed.
 *
 * It throws a `Clerk error:` for an option that is not valid, such as a URI outside `ui://`, one not written as
 * `new URL(uri).href` writes it, or a CSP entry that is not an origin, and logs a one-time `Clerk warning:` for each URI whose template does not start with
 * `<!DOCTYPE html>`, declares no `color-scheme`, or contains a Clerk secret key.
 * @param options - The view's name, URI, HTML, and optional listing metadata, CSP, and `prefersBorder`
 * @returns Arguments for `server.registerResource`
 */
export function mcpAppViewResource(options: McpAppViewResourceOptions): McpAppViewResource {
  assertOptions(options);
  const { name, uri, html, title, description, csp, prefersBorder } = options;
  warnAboutTemplate(uri, html);
  if (registerAppView(uri)) {
    console.warn(
      `Clerk warning: ${CALLER} built ${uri} after mcpAuth checked a request, so publicAccess.views did not open it for the requests before. Build views once at module scope, not inside the server factory.`,
    );
  }

  const cspMeta: Partial<Record<CspKey, string[]>> = {};
  for (const key of CSP_KEYS) {
    const origins = csp?.[key];
    if (origins && origins.length > 0) cspMeta[key] = [...origins];
  }
  const ui: McpAppViewUiMeta = {
    ...(Object.keys(cspMeta).length > 0 && { csp: cspMeta }),
    ...(prefersBorder !== undefined && { prefersBorder }),
  };
  const meta = Object.keys(ui).length > 0 ? { _meta: { ui } } : {};

  return [
    name,
    uri,
    {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => ({ contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: html, ...meta }] }),
  ];
}

function assertOptions(options: unknown): asserts options is McpAppViewResourceOptions {
  if (!isPlainObject(options)) fail('takes an options object');
  assertKnownKeys(fail, options, {
    allowed: optionKeys,
    unknownMessage: (key) => `has no ${key} option. It takes any of ${[...optionKeys].join(', ')}`,
  });
  const { name, uri, html, title, description, csp, prefersBorder } = options;
  if (typeof name !== 'string' || name.trim() === '') fail('name must be a non-empty string');
  // MCP Apps 2026-01-26, UI Resource Format: "URI MUST start with `ui://` scheme"
  if (typeof uri !== 'string' || !uri.startsWith('ui://') || uri.length === 'ui://'.length) {
    fail('uri must be a ui:// URI, such as ui://my-server/view.html');
  }
  // The MCP SDKs register a resource under its URI as given but look a read up by `new URL(uri).href`, so a view at a
  // URI in another form could never be read, and `publicAccess.views` would open a string the SDK does not serve
  const canonical = canonicalUri(uri);
  if (canonical !== uri) {
    fail(
      canonical === undefined
        ? `uri ${uri} is not a URL, such as ui://my-server/view.html`
        : `uri must be written as the MCP SDKs read it, ${canonical}, not ${uri}`,
    );
  }
  if (typeof html !== 'string') fail("html must be the view's HTML document, as a string");
  for (const [key, value] of [
    ['title', title],
    ['description', description],
  ] as const) {
    if (value !== undefined && typeof value !== 'string') fail(`${key} must be a string`);
  }
  if (prefersBorder !== undefined && typeof prefersBorder !== 'boolean') {
    fail('prefersBorder must be true or false');
  }
  if (csp === undefined) return;
  if (!isPlainObject(csp)) {
    fail("csp must be an object, such as { resourceDomains: ['https://cdn.example.com'] }");
  }
  assertKnownKeys(fail, csp, {
    allowed: cspKeys,
    unknownMessage: (key) => `csp has no ${key} option. It takes any of ${CSP_KEYS.join(', ')}`,
  });
  for (const key of CSP_KEYS) {
    const origins = csp[key];
    if (origins === undefined) continue;
    if (
      !Array.isArray(origins) ||
      !origins.every((origin) => typeof origin === 'string' && ORIGIN.test(origin))
    ) {
      fail(
        `csp.${key} must list origins, such as https://api.example.com or https://*.example.com, without a path. \`*\` and a bare scheme such as https: would allow every origin`,
      );
    }
  }
}

// The URI as WHATWG URL parsing writes it, resolving dot segments and percent-encoding, or `undefined` when it does not
// parse
function canonicalUri(uri: string): string | undefined {
  try {
    return new URL(uri).href;
  } catch {
    return undefined;
  }
}

// Logs the template problems a host or scanner would flag, once for each URI
function warnAboutTemplate(uri: string, html: string) {
  if (warnedUris.has(uri)) return;
  const problems = [
    // HTML treats the doctype case-insensitively
    !/^\s*<!doctype html>/i.test(html) && 'does not start with <!DOCTYPE html>',
    !/<meta\b[^>]*\bname\s*=\s*["']?color-scheme\b/i.test(html) &&
      'declares no color-scheme, as <meta name="color-scheme" content="light dark">, so it may not follow the host\'s theme',
    /\bsk_(?:live|test)_/.test(html) &&
      'contains a Clerk secret key (sk_live_ or sk_test_), which anyone who can read the view would see. Remove it now and rotate the key',
  ].filter((problem) => problem !== false);
  if (problems.length === 0) return;
  warnedUris.add(uri);
  console.warn(`Clerk warning: ${CALLER} ${uri}: the template ${problems.join('; it ')}.`);
}
