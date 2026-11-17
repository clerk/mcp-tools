// The `resourceUrl` rules every entry point shares: which configured URL a request is for, and what a configured URL
// may be. The auth and discovery modules both import it, and `./server` re-exports its public names, so it imports
// nothing of its own. This module is not a package entry point.

/**
 * The exact URL clients use for an MCP endpoint, or a list of them, one for each origin, for a server that answers on
 * several hostnames. With a list, a request uses the URL with its own origin, and a request to any other origin gets a
 * 421 Misdirected Request (RFC 9110 section 15.5.20).
 */
export type McpResourceUrl = string | readonly string[];

/**
 * The URL from `resourceUrl` that a request to `requestUrl` is for: `resourceUrl` itself when it is one URL, or the
 * listed URL with the request's origin. `undefined` when no listed URL has that origin. This is the rule `mcpAuth`,
 * `withMcpAuth`, and `protectedResourceMetadataHandler` apply to their `resourceUrl`, so use it in a protected resource
 * metadata route of your own, such as one for another authorization server, to keep its `resource` identical to the
 * URL they check, and answer `421` when it returns `undefined`.
 * @example
 * ```ts
 * const resource = matchResourceUrl(['https://mcp.example.com/mcp', 'https://mcp.example.dev/mcp'], request.url);
 * if (!resource) return new Response(null, { status: 421 });
 * ```
 */
export function matchResourceUrl(
  resourceUrl: string | readonly string[],
  requestUrl: string | URL,
): string | undefined {
  if (typeof resourceUrl === 'string') return resourceUrl;
  const { origin } = new URL(requestUrl);
  return resourceUrl.find((url) => URL.canParse(url) && new URL(url).origin === origin);
}

// Each URL is checked once here, so a request only has to find the one with its origin.
export function assertResourceUrls(caller: string, resourceUrl: unknown) {
  const urls: unknown = typeof resourceUrl === 'string' ? [resourceUrl] : resourceUrl;
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(`Clerk error: ${caller} resourceUrl must be a URL or a non-empty list of URLs`);
  }

  const origins = new Set<string>();
  for (const url of urls) {
    if (typeof url !== 'string' || !isResourceUrl(url)) {
      throw new Error(
        `Clerk error: ${caller} resourceUrl must be an absolute http or https URL without credentials or a fragment`,
      );
    }
    // The request's origin picks the URL, so two URLs with one origin would leave the choice ambiguous
    const { origin } = new URL(url);
    if (origins.has(origin)) {
      throw new Error(
        `Clerk error: ${caller} resourceUrl lists more than one URL for ${origin}. List one URL for each origin`,
      );
    }
    origins.add(origin);
  }
}

// A URL with another scheme, such as `mailto:`, has no origin for the challenge, `new Request` throws on a URL with
// credentials, and a resource identifier must not have a fragment (RFC 8707 section 2).
export function isResourceUrl(value: string): boolean {
  if (!URL.canParse(value) || value.includes('#')) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
}
