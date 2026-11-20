// The AI Catalog builder: a catalog of linked MCP Server Cards, the supported subset of the AI Catalog specification
// pinned at Agent-Card/ai-catalog@19208af (#141, the v0.9 release candidate). `./server` re-exports its public names, so
// it must not import `./server`. This module is not a package entry point.
import { assertKnownKeys, deepFreeze, failFor, isPlainObject } from './discovery-options';
import { isStaticHttpUrl, isUri } from './server-card';

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
   * `urn:air:example.com:weather:mcp`. The v0.9 release candidate recommends `urn:air:{publisher}:{name}[:{kind}]`;
   * this is a logical identifier, not a URL.
   */
  identifier: string;
  /**
   * The server's human-readable name, such as `Weather`. Agentic Resource Discovery (ARD) v0.91 requires it on every
   * entry. The v0.9 release candidate makes it optional and, when present, a consumer shows it instead of the card's
   * `title`, so keep the two the same.
   */
  displayName: string;
  /**
   * The exact URL the Server Card is retrieved from, such as `https://example.com/mcp/server-card`. It may be on
   * another host. It must be https, except on `localhost`, `127.0.0.1`, or `[::1]`, where http is allowed for local
   * development. It is never fetched.
   */
  url: string;
  /**
   * Who stands behind the server, as an Agentic Resource Discovery (ARD) v0.91 trust manifest. Omit it to publish no
   * trust data. It is emitted as given.
   */
  trustManifest?: AICatalogTrustManifest | undefined;
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
 * The trust manifest of an AI Catalog entry, the subset of the Agentic Resource Discovery (ARD) v0.91 `trustManifest`
 * this builder supports: an identity and the attestations that back it. Trust schemas, provenance, and signatures are
 * not supported.
 * @see https://agenticresourcediscovery.org/spec
 */
export type AICatalogTrustManifest = {
  /**
   * The publisher's identity, an absolute URI such as `https://example.com`, `did:web:example.com`, or a SPIFFE ID.
   * ARD requires its trust domain to match the publisher in the entry's `identifier`, as `example.com` in
   * `urn:air:example.com:weather:mcp`.
   */
  readonly identity: string;
  /**
   * A hint for the format of `identity`, such as `https`, `did`, or `spiffe`. ARD leaves its values open.
   */
  readonly identityType?: string | undefined;
  /**
   * Claims about the server, each a document at `uri`, such as a compliance report.
   */
  readonly attestations?: readonly AICatalogAttestation[] | undefined;
};

/**
 * One attestation of a trust manifest: a claim of a given type, backed by the document at `uri`.
 */
export type AICatalogAttestation = {
  /**
   * The kind of claim, such as `SOC2-Type2`.
   */
  readonly type: string;
  /**
   * The absolute URI of the attestation document.
   */
  readonly uri: string;
  /**
   * A digest of the attestation document, such as `sha256:...`.
   */
  readonly digest?: string | undefined;
  /**
   * The media type of the attestation document, such as `application/pdf`.
   */
  readonly mediaType?: string | undefined;
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
   * Generated: always `0.9`, the v0.9 release candidate of the AI Catalog specification.
   */
  specVersion?: never;
};

/**
 * An entry of an AI Catalog, as `generateAICatalog` generates it.
 */
export type AICatalogEntry = {
  readonly identifier: string;
  readonly displayName: string;
  readonly type: typeof SERVER_CARD_TYPE;
  readonly url: string;
  readonly trustManifest?: AICatalogTrustManifest;
};

/**
 * An AI Catalog, as `generateAICatalog` generates it. It is frozen, all the way down.
 */
export type AICatalog = {
  readonly specVersion: '0.9';
  readonly entries: readonly AICatalogEntry[];
};

/**
 * Generates an AI Catalog that links to MCP Server Cards, the document a client reads at its canonical path
 * `/.well-known/ard.json`, or its predecessor path `/.well-known/ai-catalog.json`, to find a domain's MCP servers. It
 * supports a subset of the AI Catalog specification: a minimal (Level 1) catalog whose entries each link one Server
 * Card by a logical identifier, a display name, and the card's URL, with an optional ARD trust manifest. Inline
 * documents, other artifact types, host information, AI Catalog `trustManifests`, signatures, and extensions are not
 * supported. It makes no request, so it never fetches the cards, and needs no Clerk keys or MCP SDK.
 * @see https://github.com/Agent-Card/ai-catalog/blob/19208af/specification/ai-catalog.md
 * @param options - See `AICatalogOptions`
 * @returns The catalog, frozen, serializable to JSON. It throws a `Clerk error:` naming the first option the catalog
 * cannot have, such as an unknown key, a `specVersion` of its own, or an identifier listed twice.
 * @example
 * ```ts
 * const catalog = generateAICatalog({
 *   entries: [
 *     {
 *       identifier: 'urn:air:example.com:weather:mcp',
 *       displayName: 'Weather',
 *       url: 'https://mcp.example.com/mcp/server-card',
 *     },
 *   ],
 * });
 * ```
 */
export function generateAICatalog(options: AICatalogOptions): AICatalog {
  return buildAICatalog('generateAICatalog', options);
}

const catalogKeys = new Set(['entries']);
const generatedCatalogKeys = new Set(['specVersion']);
const entryKeys = new Set(['identifier', 'displayName', 'url', 'trustManifest']);
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
      "takes an options object with entries, as generateAICatalog({ entries: [{ identifier: 'urn:air:example.com:weather:mcp', displayName: 'Weather', url: 'https://example.com/mcp/server-card' }] })",
    );
  }
  assertKnownKeys(fail, options, {
    allowed: catalogKeys,
    generated: generatedCatalogKeys,
    generatedMessage: () =>
      "cannot set specVersion: the catalog's specVersion and each entry's type are generated",
    unknownMessage: (key) =>
      `does not take ${key}. An AI Catalog here supports only entries, each linking one Server Card by identifier, displayName, and url`,
  });
  const { entries } = options;
  // The pinned specification: "This array MAY be empty."
  if (!Array.isArray(entries) || !Array.from(entries).every(isPlainObject)) {
    return fail(
      "entries must be a list of { identifier, displayName, url }, such as [{ identifier: 'urn:air:example.com:weather:mcp', displayName: 'Weather', url: 'https://example.com/mcp/server-card' }]",
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
        `${at} does not take ${key}. An entry supports identifier, displayName, url, and trustManifest only: inline documents, other artifact types, versions, AI Catalog trustManifests, and extensions are not supported`,
    });
    const { identifier, displayName, url, trustManifest } = entry;
    if (!isIdentifier(identifier)) {
      fail(
        `${at}.identifier must be a logical identifier without spaces, such as 'urn:air:example.com:weather:mcp'. It names the server and is not the URL of its card`,
      );
    }
    if (identifiers.has(identifier as string)) {
      fail(
        `entries lists the identifier ${identifier} more than once. Each entry needs its own identifier`,
      );
    }
    identifiers.add(identifier as string);
    if (!isDisplayName(displayName)) {
      fail(
        `${at}.displayName must be a human-readable name for the server, such as 'Weather', with more than whitespace and no control characters`,
      );
    }
    if (!isCardUrl(url)) {
      fail(
        `${at}.url must be an absolute https URL, or http on localhost, 127.0.0.1, or [::1] for local development, without credentials, a fragment, or spaces`,
      );
    }
    if (trustManifest !== undefined && !isTrustManifest(trustManifest)) {
      fail(
        `${at}.trustManifest must be { identity, identityType?, attestations? } with an absolute URI identity, such as 'https://example.com', and attestations a list of { type, uri, digest?, mediaType? } with an absolute URI uri. Trust schemas, provenance, and signatures are not supported`,
      );
    }
    return {
      identifier: identifier as string,
      displayName: displayName as string,
      type: SERVER_CARD_TYPE,
      url: url as string,
      ...(trustManifest === undefined
        ? {}
        : { trustManifest: JSON.parse(JSON.stringify(trustManifest)) as AICatalogTrustManifest }),
    };
  });

  return deepFreeze({ specVersion: '0.9', entries: linked });
}

// The exact raw hosts a card URL may use plain http on, without WHATWG hostname normalization.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// A card URL is https, so a client reads the card it links over TLS, except on a loopback host, which a local
// development server answers on
function isCardUrl(value: unknown): value is string {
  if (!isStaticHttpUrl(value)) return false;
  if (value.startsWith('https://')) return true;
  const rawHostname = /^http:\/\/(?::?@)?(\[[^\]]+\]|[^:/?#]+)/.exec(value)?.[1];
  return rawHostname !== undefined && LOOPBACK_HOSTS.has(rawHostname.toLowerCase());
}

const trustManifestKeys = new Set(['identity', 'identityType', 'attestations']);
const attestationKeys = new Set(['type', 'uri', 'digest', 'mediaType']);

// The ARD v0.91 entry schema's TrustManifest, of which only identity is required. Its other members (trustSchema,
// provenance, signature) are rejected rather than emitted unchecked
function isTrustManifest(value: unknown): boolean {
  if (!isPlainObject(value) || !Object.keys(value).every((key) => trustManifestKeys.has(key))) {
    return false;
  }
  const { identity, identityType, attestations } = value;
  return (
    isUri(identity) &&
    (identityType === undefined || isToken(identityType)) &&
    (attestations === undefined ||
      (Array.isArray(attestations) && Array.from(attestations).every(isAttestation)))
  );
}

// The schema's attestation item: a type and a uri are required, a digest and mediaType are optional text
function isAttestation(value: unknown): boolean {
  if (!isPlainObject(value) || !Object.keys(value).every((key) => attestationKeys.has(key))) {
    return false;
  }
  const { type, uri, digest, mediaType } = value;
  return (
    isDisplayName(type) &&
    isUri(uri) &&
    (digest === undefined || isToken(digest)) &&
    (mediaType === undefined || isDisplayName(mediaType))
  );
}

// Open text that names a format or carries a value, so it may not be empty or hold whitespace or control characters
function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s\p{Cc}]/u.test(value);
}

// Text in the specification, required by ARD: rejected only when it shows nothing, being empty or whitespace, or
// carries control characters
function isDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/\p{Cc}/u.test(value);
}

// Open text in the specification, so only what can't be a logical identifier is rejected: nothing, whitespace or
// control characters, or an http(s) URL, which would be a retrieval address rather than a name for the server
function isIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\s\p{Cc}]/u.test(value)) return false;
  if (!URL.canParse(value)) return true;
  const { protocol } = new URL(value);
  return protocol !== 'http:' && protocol !== 'https:';
}
