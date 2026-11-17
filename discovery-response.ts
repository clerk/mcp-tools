// The HTTP answers every discovery handler gives, whatever the framework: the methods, the public CORS headers, the
// cache policy, the validator and conditional requests, and the 421 for an origin no listed URL has. The adapters only
// read the request and send the answer. It imports nothing from `./server`, which re-exports the builders.
// This module is not a package entry point.
import { type McpResourceUrl, assertResourceUrls, matchResourceUrl } from './resource-url';
import { type ServerCardOptions, buildServerCard } from './server-card';

/**
 * Options for a `serverCardHandler`: the `generateServerCard` options, with `resourceUrl` as a URL or a list of
 * them, one for each origin, and the cache lifetime.
 */
export type ServerCardHandlerOptions = Omit<ServerCardOptions, 'resourceUrl'> & {
  /**
   * The exact URL of the MCP endpoint the card advertises, or a list of them, one for each origin the app answers on.
   * With a list, a request gets the card for the URL with its own origin, and a request to any other origin gets a
   * 421. The browser's `Origin` header plays no part.
   */
  resourceUrl: McpResourceUrl;
  /**
   * How many seconds a client or cache may reuse the card before revalidating it with its ETag, a whole number. The
   * default is 3600, an hour. `0` lets caches store it but has them revalidate it on every use.
   */
  maxAge?: number | undefined;
};

/**
 * A request, as the adapter reads it.
 */
export type DiscoveryRequest = {
  method: string;
  /**
   * The URL the request was made to, which picks a listed `resourceUrl`
   */
  url: string;
  /**
   * The request's `If-None-Match` field, its lines joined with commas
   */
  ifNoneMatch: string | null | undefined;
};

/**
 * The status, headers, and serialized body an adapter sends, `null` for no body.
 */
export type DiscoveryAnswer = {
  status: 200 | 304 | 405 | 421;
  headers: Record<string, string>;
  body: string | null;
};

const DEFAULT_MAX_AGE = 3600;
const ALLOW = 'GET, HEAD, OPTIONS';

// Any origin may read a discovery document, which is public, and revalidate it: If-None-Match is not a CORS-safelisted
// request header, and ETag is not a safelisted response header
const discoveryCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': ALLOW,
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};

const json = (status: 405 | 421, error: string, head: boolean, headers = {}): DiscoveryAnswer => ({
  status,
  headers: { ...discoveryCorsHeaders, 'Content-Type': 'application/json', ...headers },
  body: head ? null : JSON.stringify({ error }),
});

/**
 * Validates a `serverCardHandler`'s options and generates the card for each configured URL once, so the answers are
 * fixed: changing the options afterward changes nothing.
 * @param caller - The entry point named in error messages
 * @param options - The handler's options, unchecked
 * @returns The function that answers each request
 */
export function serverCardResponder(caller: string, options: unknown) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error(
      `Clerk error: ${caller} takes an options object with name, version, description, and resourceUrl, as ${caller}({ name: 'com.example/weather', version: '1.0.0', description: 'Forecasts.', resourceUrl: 'https://mcp.example.com/mcp' })`,
    );
  }
  const { resourceUrl, maxAge, ...card } = options as ServerCardHandlerOptions;
  return discoveryResponder(caller, {
    resourceUrl,
    maxAge,
    mediaType: 'application/mcp-server-card+json',
    build: (url) => buildServerCard(caller, { ...card, resourceUrl: url }),
  });
}

/**
 * The answers of a discovery handler, from a document for each configured URL.
 * @param caller - The entry point named in error messages
 * @param config - The configured URL or URLs, the cache lifetime, the document's media type, and its builder
 */
function discoveryResponder(
  caller: string,
  config: {
    resourceUrl: unknown;
    maxAge: unknown;
    mediaType: string;
    build: (url: string) => unknown;
  },
) {
  assertResourceUrls(caller, config.resourceUrl);
  const maxAge = config.maxAge ?? DEFAULT_MAX_AGE;
  if (typeof maxAge !== 'number' || !Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new Error(
      `Clerk error: ${caller} maxAge must be a whole number of seconds, 0 or more, or left out for 3600`,
    );
  }
  const resourceUrl = config.resourceUrl as McpResourceUrl;
  // RFC 9111 section 5.2.2.9: `public` lets a shared cache reuse the document for a request with an Authorization
  // header (section 3.5). With 0, `no-cache` lets caches store it but not reuse it without revalidating (section
  // 5.2.2.4), which the ETag makes cheap.
  const cacheControl = maxAge === 0 ? 'public, no-cache' : `public, max-age=${maxAge}`;

  const representations = new Map(
    [resourceUrl].flat().map((url) => {
      const body = JSON.stringify(config.build(url));
      return [url, { body, etag: weakEtag(body) }] as const;
    }),
  );

  return ({ method, url, ifNoneMatch }: DiscoveryRequest): DiscoveryAnswer => {
    if (method === 'OPTIONS') {
      return { status: 200, headers: { ...discoveryCorsHeaders, Allow: ALLOW }, body: null };
    }
    const head = method === 'HEAD';
    if (method !== 'GET' && !head) {
      return json(405, 'method_not_allowed', false, { Allow: ALLOW });
    }
    const selected = matchResourceUrl(resourceUrl, url);
    // RFC 9110 section 15.5.20. No representation is selected, so If-None-Match is not evaluated.
    if (selected === undefined) return json(421, 'misdirected_request', head);
    const { body, etag } = representations.get(selected)!;

    const validators = { ...discoveryCorsHeaders, ETag: etag, 'Cache-Control': cacheControl };
    // RFC 9110 section 15.4.5: a 304 has the ETag and Cache-Control a 200 would have, but no content or Content-Type
    if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, etag)) {
      return { status: 304, headers: validators, body: null };
    }
    return {
      status: 200,
      headers: { ...validators, 'Content-Type': config.mediaType },
      body: head ? null : body,
    };
  };
}

/**
 * A weak entity tag from the document's bytes. Weak, since a compression middleware or CDN can send another content
 * coding of the same document under the same tag, which a strong validator cannot share (RFC 9110 section 8.8.1). A
 * synchronous 64-bit hash (cyrb53's mixing, both halves kept) keeps the factories synchronous on every runtime: a tag
 * only has to change when the document does, and nothing relies on it being unguessable.
 */
function weakEtag(body: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const byte of new TextEncoder().encode(body)) {
    h1 = Math.imul(h1 ^ byte, 2654435761);
    h2 = Math.imul(h2 ^ byte, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `W/"${hex(h2)}${hex(h1)}"`;
}

// One list element: optional whitespace, then an optional entity-tag, then a comma or the end. Empty elements are
// skipped (RFC 9110 section 5.6.1). An opaque-tag may itself contain a comma (section 8.8.3).
const LIST_ELEMENT = /^[ \t]*(?:(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*"))?[ \t]*(?:,|$)/;

/**
 * Whether an If-None-Match field value matches `etag` (RFC 9110 section 13.1.2): `*`, or a list with an entity-tag
 * whose opaque-tag is `etag`'s, the weak comparison of section 8.8.3.2, which ignores either side's `W/`. A value
 * that is not valid syntax, including `*` in a list, matches nothing, so the document is sent in full.
 */
function matchesIfNoneMatch(value: string, etag: string): boolean {
  if (value.trim() === '*') return true;
  const opaque = etag.replace(/^W\//, '');
  let rest = value;
  let matched = false;
  while (rest.length > 0) {
    const element = LIST_ELEMENT.exec(rest);
    if (!element || element[0].length === 0) return false;
    if (element[1] === opaque) matched = true;
    rest = rest.slice(element[0].length);
  }
  return matched;
}
