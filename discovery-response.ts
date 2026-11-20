// The HTTP answers every discovery handler gives, whatever the framework: the methods, the public CORS headers, the
// cache policy, the validator and conditional requests, and the 421 for an origin no listed URL has. The adapters only
// read the request and send the answer. It imports nothing from `./server`, which re-exports the builders.
// This module is not a package entry point.
import { failFor, isPlainObject } from './discovery-options';
import { type McpResourceUrl, assertResourceUrls, matchResourceUrl } from './resource-url';
import { type AICatalogOptions, buildAICatalog } from './ai-catalog';
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
 * Options for an `aiCatalogHandler`: the `generateAICatalog` options and the cache lifetime. The catalog is the same
 * for every request; an app that answers on several origins mounts one handler for each.
 */
export type AICatalogHandlerOptions = AICatalogOptions & {
  /**
   * How many seconds a client or cache may reuse the catalog before revalidating it with its ETag, a whole number. The
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
   * The URL the request was made to, which picks a listed `resourceUrl`, `undefined` when the adapter found none, as
   * for an Express request without a `Host` header that parses. A document served to every request never reads it.
   */
  url: string | undefined;
  /**
   * The request's `If-None-Match` field, its lines joined with commas
   */
  ifNoneMatch: string | null | undefined;
  /**
   * The request's `If-Match` field, its lines joined with commas
   */
  ifMatch: string | null | undefined;
};

/**
 * The status, headers, and serialized body an adapter sends, `null` for no body.
 */
export type DiscoveryAnswer = {
  status: 200 | 304 | 400 | 405 | 412 | 421;
  headers: Record<string, string>;
  body: string | null;
};

const DEFAULT_MAX_AGE = 3600;
const ALLOW = 'GET, HEAD, OPTIONS';

// Any origin may read a public discovery document and send preconditions: If-Match and If-None-Match are not
// CORS-safelisted request headers, and ETag is not a safelisted response header
const discoveryCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': ALLOW,
  'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};

// The JSON error a request gets, with its body even for HEAD: the responder drops a HEAD answer's body in one place.
// `no-store` keeps every error out of caches (RFC 9111 section 5.2.2.5): without it, a 405 is heuristically cacheable
// (RFC 9110 section 15.1), and a cache may reuse it with heuristic freshness (RFC 9111 section 4.2.2).
const errorAnswer = (
  status: 400 | 405 | 412 | 421,
  error: string,
  headers: Record<string, string> = {},
): DiscoveryAnswer => ({
  status,
  headers: {
    ...discoveryCorsHeaders,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  },
  body: JSON.stringify({ error }),
});

/**
 * Validates a `serverCardHandler`'s options and generates the card for each configured URL once, so the answers are
 * fixed: changing the options afterward changes nothing.
 * @param caller - The entry point named in error messages
 * @param options - The handler's options, unchecked
 * @returns The function that answers each request
 */
export function serverCardResponder(caller: string, options: unknown) {
  if (!isPlainObject(options)) {
    return failFor(caller)(
      `takes an options object with name, version, description, and resourceUrl, as ${caller}({ name: 'com.example/weather', version: '1.0.0', description: 'Forecasts.', resourceUrl: 'https://mcp.example.com/mcp' })`,
    );
  }
  const { resourceUrl: configured, maxAge, ...card } = options as ServerCardHandlerOptions;
  assertResourceUrls(caller, configured);
  return discoveryResponder(caller, {
    maxAge,
    mediaType: 'application/mcp-server-card+json',
    build: () => {
      // One URL is advertised whatever the request's origin, so the request's URL is never needed
      if (typeof configured === 'string') {
        return { document: buildServerCard(caller, { ...card, resourceUrl: configured }) };
      }
      // A copy, so a list changed after setup can't select a URL without a built document
      const listed = [...configured];
      return {
        byUrl: new Map(
          listed.map(
            (url) => [url, buildServerCard(caller, { ...card, resourceUrl: url })] as const,
          ),
        ),
        select: (url) => matchResourceUrl(listed, url),
      };
    },
  });
}

/**
 * Validates an `aiCatalogHandler`'s options and generates its catalog once, so the answers are fixed: changing the
 * options afterward changes nothing.
 * @param caller - The entry point named in error messages
 * @param options - The handler's options, unchecked
 * @returns The function that answers each request
 */
export function aiCatalogResponder(caller: string, options: unknown) {
  // Anything but an object goes to the builder as it is, which names the options it takes
  const isObject = isPlainObject(options);
  const { maxAge, ...catalog } = isObject ? (options as AICatalogHandlerOptions) : {};
  return discoveryResponder(caller, {
    maxAge,
    mediaType: 'application/ai-catalog+json',
    // One catalog, whatever the request's URL
    build: () => ({ document: buildAICatalog(caller, isObject ? catalog : options) }),
  });
}

/**
 * The answers of a discovery handler, from the document a request's URL selects.
 * @param caller - The entry point named in error messages
 * @param config - The cache lifetime, the documents' media type, and `build`, called once after `maxAge` is checked,
 * which builds the document or documents to serve
 */
function discoveryResponder(
  caller: string,
  config: { maxAge: unknown; mediaType: string; build: () => DiscoveryDocuments },
) {
  const maxAge = config.maxAge === undefined ? DEFAULT_MAX_AGE : config.maxAge;
  if (typeof maxAge !== 'number' || !Number.isSafeInteger(maxAge) || maxAge < 0) {
    failFor(caller)('maxAge must be a whole number of seconds, 0 or more, or left out for 3600');
  }
  // RFC 9111 section 5.2.2.9: `public` explicitly marks the document cacheable, including for a shared cache and a
  // request with an Authorization header (section 3.5). With 0, `no-cache` has a cache revalidate before each reuse
  // (section 5.2.2.4), which the ETag makes cheap.
  const cacheControl = maxAge === 0 ? 'public, no-cache' : `public, max-age=${maxAge}`;

  const pick = representationPicker(config.build());

  const answer = ({ method, url, ifMatch, ifNoneMatch }: DiscoveryRequest): DiscoveryAnswer => {
    if (method === 'OPTIONS') {
      return { status: 200, headers: { ...discoveryCorsHeaders, Allow: ALLOW }, body: null };
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return errorAnswer(405, 'method_not_allowed', { Allow: ALLOW });
    }
    const picked = pick(url);
    if ('status' in picked) return picked;
    const { body, etag } = picked;

    // RFC 9110 sections 13.1.1 and 13.2.2: If-Match precedes If-None-Match and uses strong comparison. Our ETags
    // are always weak, so no listed tag can match; only * succeeds now that a representation has been selected.
    if (ifMatch != null && ifMatch.trim() !== '*') {
      return errorAnswer(412, 'precondition_failed');
    }

    const validators = { ...discoveryCorsHeaders, ETag: etag, 'Cache-Control': cacheControl };
    // RFC 9110 section 15.4.5: a 304 has the ETag and Cache-Control a 200 would have, but no content or Content-Type
    if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, etag)) {
      return { status: 304, headers: validators, body: null };
    }
    return { status: 200, headers: { ...validators, 'Content-Type': config.mediaType }, body };
  };

  // HEAD gets the headers GET would, without the content. Its Content-Length is the GET's, which is known before any
  // content is sent, so RFC 9110 section 9.3.2 has the server send it; the adapters send no body to measure.
  return (request: DiscoveryRequest): DiscoveryAnswer => {
    const response = answer(request);
    if (request.method !== 'HEAD' || response.body === null) return response;
    const contentLength = String(new TextEncoder().encode(response.body).byteLength);
    return {
      ...response,
      headers: { ...response.headers, 'Content-Length': contentLength },
      body: null,
    };
  };
}

/**
 * What a discovery handler serves: one `document` for every request, or documents `byUrl`, with `select` returning
 * the key of the one a request's URL is for, `undefined` for none.
 */
type DiscoveryDocuments =
  | { document: unknown }
  | {
      byUrl: ReadonlyMap<string, unknown>;
      select: (url: string) => string | undefined;
    };

/**
 * A serialized document and its validator.
 */
type Representation = { body: string; etag: string };

/**
 * Serializes the documents once and returns how a request's URL picks one, or the error answer when it can't.
 */
function representationPicker(
  documents: DiscoveryDocuments,
): (url: string | undefined) => Representation | DiscoveryAnswer {
  const represent = (document: unknown): Representation => {
    const body = JSON.stringify(document);
    return { body, etag: weakEtag(body) };
  };
  if ('document' in documents) {
    const fixed = represent(documents.document);
    return () => fixed;
  }
  const byUrl = new Map(
    [...documents.byUrl].map(([key, document]) => [key, represent(document)] as const),
  );
  return (url) => {
    // Without a URL there is no origin to select by, so this is answered as protected resource metadata is
    if (url === undefined) return errorAnswer(400, 'invalid_request');
    const key = documents.select(url);
    const representation = key === undefined ? undefined : byUrl.get(key);
    // RFC 9110 sections 13.2.1 and 15.5.20. No representation is selected, so preconditions are not evaluated.
    return representation ?? errorAnswer(421, 'misdirected_request');
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
// skipped (RFC 9110 section 5.6.1.2). An opaque-tag may itself contain a comma (section 8.8.3).
const LIST_ELEMENT = /^[ \t]*(?:(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")[ \t]*)?(?:,|$)/;

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
