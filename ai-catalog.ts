// The AI Catalog builder: a catalog of linked MCP Server Cards, the supported subset of the AI Catalog specification
// pinned at Agent-Card/ai-catalog@4d522ea41c025118e55c7e689b72cc15bf332937. `./server` re-exports its public names, so
// it must not import `./server`. This module is not a package entry point.
import { assertKnownKeys, deepFreeze, failFor, isPlainObject } from './discovery-options';
import { isStaticHttpUrl } from './server-card';

/**
 * The media type of the document an AI Catalog entry links to: an MCP Server Card.
 */
const SERVER_CARD_TYPE = 'application/mcp-server-card+json' as const;

/**
 * One Server Card an AI Catalog links to.
 */
export type AICatalogEntryOptions = {
  /**
   * The server's logical identifier, which stays the same wherever the card is hosted, such as
   * `urn:air:example.com:mcp:weather`. It is not a URL.
   */
  identifier: string;
  /**
   * The exact URL the Server Card is retrieved from, such as `https://example.com/mcp/server-card`. It may be on
   * another host. It must be https, except on `localhost`, `127.0.0.1`, or `[::1]`, where http is allowed for local
   * development. It is never fetched.
   */
  url: string;
  /**
   * Generated: every entry links a Server Card, `application/mcp-server-card+json`.
   */
  type?: never;
  /**
   * Not supported: an entry links its card by `url` and never includes it inline.
   */
  data?: never;
};

/**
 * Input to `generateAICatalog`: the Server Cards it links to.
 */
export type AICatalogOptions = {
  /**
   * One entry for each Server Card, in the order the catalog lists them. It may be empty, as the specification allows.
   */
  entries: readonly AICatalogEntryOptions[];
  /**
   * Generated: always `1.0`, the version of the AI Catalog specification the catalog follows.
   */
  specVersion?: never;
};

/**
 * An entry of an AI Catalog, as `generateAICatalog` generates it.
 */
export type AICatalogEntry = {
  readonly identifier: string;
  readonly type: typeof SERVER_CARD_TYPE;
  readonly url: string;
};

/**
 * An AI Catalog, as `generateAICatalog` generates it. It is frozen, all the way down.
 */
export type AICatalog = {
  readonly specVersion: '1.0';
  readonly entries: readonly AICatalogEntry[];
};

/**
 * Generates an AI Catalog that links to MCP Server Cards, the document a client reads at
 * `/.well-known/ai-catalog.json` to find a domain's MCP servers. It supports a subset of the AI Catalog
 * specification: a minimal (Level 1) catalog whose entries each link one Server Card by a logical identifier and the
 * card's URL. Inline documents, other artifact types, host information, trust manifests, signatures, and extensions
 * are not supported. It makes no request, so it never fetches the cards, and needs no Clerk keys or MCP SDK.
 * @see https://github.com/Agent-Card/ai-catalog
 * @param options - See `AICatalogOptions`
 * @returns The catalog, frozen, serializable to JSON. It throws a `Clerk error:` naming the first option the catalog
 * cannot have, such as an unknown key, a `specVersion` of its own, or an identifier listed twice.
 * @example
 * ```ts
 * const catalog = generateAICatalog({
 *   entries: [
 *     { identifier: 'urn:air:example.com:mcp:weather', url: 'https://mcp.example.com/mcp/server-card' },
 *   ],
 * });
 * ```
 */
export function generateAICatalog(options: AICatalogOptions): AICatalog {
  return buildAICatalog('generateAICatalog', options);
}

const catalogKeys = new Set(['entries']);
const generatedCatalogKeys = new Set(['specVersion']);
const entryKeys = new Set(['identifier', 'url']);
const generatedEntryKeys = new Set(['type']);

/**
 * Validates the options of `generateAICatalog` or an `aiCatalogHandler` and generates the catalog, a frozen copy that
 * shares nothing with the options.
 * @param caller - The entry point named in error messages
 * @param options - The options, unchecked
 * @returns The catalog, frozen. It throws a `Clerk error:` naming the first option the catalog cannot have.
 */
export function buildAICatalog(caller: string, options: unknown): AICatalog {
  const fail = failFor(caller);
  if (!isPlainObject(options)) {
    return fail(
      "takes an options object with entries, as generateAICatalog({ entries: [{ identifier: 'urn:air:example.com:mcp:weather', url: 'https://example.com/mcp/server-card' }] })",
    );
  }
  assertKnownKeys(fail, options, {
    allowed: catalogKeys,
    generated: generatedCatalogKeys,
    generatedMessage: () =>
      "cannot set specVersion: the catalog's specVersion and each entry's type are generated",
    unknownMessage: (key) =>
      `does not take ${key}. An AI Catalog here supports only entries, each linking one Server Card by identifier and url`,
  });
  const { entries } = options;
  // The pinned specification: "This array MAY be empty."
  if (!Array.isArray(entries) || !Array.from(entries).every(isPlainObject)) {
    return fail(
      "entries must be a list of { identifier, url }, such as [{ identifier: 'urn:air:example.com:mcp:weather', url: 'https://example.com/mcp/server-card' }]",
    );
  }

  const identifiers = new Set<string>();
  const linked = (entries as Record<string, unknown>[]).map((entry, index) => {
    const at = `entries[${index}]`;
    assertKnownKeys(fail, entry, {
      allowed: entryKeys,
      generated: generatedEntryKeys,
      generatedMessage: () =>
        `cannot set ${at}.type: every entry links a Server Card, ${SERVER_CARD_TYPE}`,
      unknownMessage: (key) =>
        `${at} does not take ${key}. An entry supports identifier and url only: inline documents, other artifact types, versions, trust manifests, and extensions are not supported`,
    });
    const { identifier, url } = entry;
    if (!isIdentifier(identifier)) {
      fail(
        `${at}.identifier must be a logical identifier without spaces, such as 'urn:air:example.com:mcp:weather'. It names the server and is not the URL of its card`,
      );
    }
    if (identifiers.has(identifier as string)) {
      fail(
        `entries lists the identifier ${identifier} more than once. Each entry needs its own identifier`,
      );
    }
    identifiers.add(identifier as string);
    if (!isCardUrl(url)) {
      fail(
        `${at}.url must be an absolute https URL, or http on localhost, 127.0.0.1, or [::1] for local development, without credentials, a fragment, or spaces`,
      );
    }
    return { identifier: identifier as string, type: SERVER_CARD_TYPE, url: url as string };
  });

  return deepFreeze({ specVersion: '1.0', entries: linked });
}

// The hosts a card URL may use plain http on, for local development. `URL` keeps an IPv6 hostname's brackets.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// A card URL is https, so a client reads the card it links over TLS, except on a loopback host, which a local
// development server answers on
function isCardUrl(value: unknown): value is string {
  if (!isStaticHttpUrl(value)) return false;
  const { protocol, hostname } = new URL(value);
  return protocol === 'https:' || LOOPBACK_HOSTS.has(hostname);
}

// Open text in the specification, so only what can't be a logical identifier is rejected: nothing, whitespace or
// control characters, or an http(s) URL, which would be a retrieval address rather than a name for the server
function isIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\s\p{Cc}]/u.test(value)) return false;
  if (!URL.canParse(value)) return true;
  const { protocol } = new URL(value);
  return protocol !== 'http:' && protocol !== 'https:';
}
