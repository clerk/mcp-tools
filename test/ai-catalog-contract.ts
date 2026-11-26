// An offline check of an AI Catalog against the CDDL schema and prose of the AI Catalog v0.9 release candidate,
// pinned at Agent-Card/ai-catalog@19208af (#141):
// https://github.com/Agent-Card/ai-catalog/blob/19208af/specification/ai-catalog.md.
// That repository publishes no JSON Schema, so this is written from its "CDDL Schema" section, and it has nothing to do
// with the Server Card schema.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown) => typeof value === 'string';
// RFC 3986 sections 2.3 and 3.2.2: reg-name includes unreserved characters (including _) and sub-delims,
// not only DNS hostname characters. Empty userinfo (@ or :@) has no username or password. Keep this
// independent of the builder's URI check.
const isExactHttpUrl = (value: string): boolean =>
  /^https?:\/\/(?::?@)?(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._~!$&'()*+,;=%-]+)(?::\d*)?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/.test(
    value,
  ) &&
  !/%(?![a-fA-F0-9]{2})/.test(value) &&
  URL.canParse(value);

/**
 * Where `document` breaks the `AICatalog` and `CatalogEntry` rules of the CDDL, with the Level 1 (Minimal Catalog)
 * requirements: an empty list when it conforms. Consumers ignore unknown members, so they are not errors.
 */
export function aiCatalogErrors(document: unknown): string[] {
  if (!isObject(document)) return ['the catalog is not an object'];
  const errors: string[] = [];
  // "specVersion": a "Major.Minor" string
  if (!isText(document.specVersion) || !/^\d+\.\d+$/.test(document.specVersion as string)) {
    errors.push('specVersion is not a Major.Minor string');
  }
  if (
    document.host !== undefined &&
    !(isObject(document.host) && isText(document.host.displayName))
  ) {
    errors.push('host has no displayName text');
  }
  // HostInfo: identifier, documentationUrl, and logoUrl are optional text
  if (isObject(document.host)) {
    for (const key of ['identifier', 'documentationUrl', 'logoUrl']) {
      if (document.host[key] !== undefined && !isText(document.host[key]))
        errors.push(`host.${key} is not text`);
    }
  }
  if (document.extensions !== undefined && !isObject(document.extensions)) {
    errors.push('extensions is not a map');
  }
  if (!Array.isArray(document.entries)) return [...errors, 'entries is not an array'];
  Array.from(document.entries).forEach((entry: unknown, index) => {
    const at = `entries[${index}]`;
    if (!isObject(entry)) return errors.push(`${at} is not an object`);
    if (!isText(entry.identifier)) errors.push(`${at}.identifier is not text`);
    if (!isText(entry.type)) errors.push(`${at}.type is not text`);
    // (url: text // data: any): exactly one of them
    if ('url' in entry === 'data' in entry)
      errors.push(`${at} has not exactly one of url and data`);
    if ('url' in entry && !isText(entry.url)) errors.push(`${at}.url is not text`);
    for (const key of ['displayName', 'version', 'description', 'updatedAt']) {
      if (entry[key] !== undefined && !isText(entry[key])) errors.push(`${at}.${key} is not text`);
    }
    if (
      entry.tags !== undefined &&
      !(Array.isArray(entry.tags) && Array.from(entry.tags).every(isText))
    ) {
      errors.push(`${at}.tags is not a list of text`);
    }
    for (const key of ['publisher', 'trustManifest', 'extensions']) {
      if (entry[key] !== undefined && !isObject(entry[key]))
        errors.push(`${at}.${key} is not a map`);
    }
    return undefined;
  });
  // Multi-Version Entries: without a version, an identifier alone must be unique
  const unversioned = document.entries
    .filter((entry) => isObject(entry) && entry.version === undefined)
    .map((entry) => (entry as Record<string, unknown>).identifier);
  if (new Set(unversioned).size !== unversioned.length) errors.push('an identifier is not unique');
  return errors;
}

// The TrustManifest of the ARD v0.91 entry schema (ard-entry.schema.json): identity is required, identityType is open
// text, and each attestation needs a type and a uri, with optional mediaType and digest text
function trustManifestErrors(manifest: unknown, entryAt: string): string[] {
  const at = `${entryAt}.trustManifest`;
  if (!isObject(manifest)) return [`${at} is not a map`];
  const errors: string[] = [];
  if (!isText(manifest.identity) || !URL.canParse(manifest.identity as string))
    errors.push(`${at}.identity is not a URI`);
  if (manifest.identityType !== undefined && !isText(manifest.identityType))
    errors.push(`${at}.identityType is not text`);
  if (manifest.attestations === undefined) return errors;
  if (!Array.isArray(manifest.attestations)) return [...errors, `${at}.attestations is not a list`];
  Array.from(manifest.attestations).forEach((attestation: unknown, index) => {
    const item = `${at}.attestations[${index}]`;
    if (!isObject(attestation)) return errors.push(`${item} is not a map`);
    if (!isText(attestation.type)) errors.push(`${item}.type is not text`);
    if (!isText(attestation.uri) || !URL.canParse(attestation.uri as string))
      errors.push(`${item}.uri is not a URI`);
    for (const key of ['mediaType', 'digest']) {
      if (attestation[key] !== undefined && !isText(attestation[key]))
        errors.push(`${item}.${key} is not text`);
    }
    return undefined;
  });
  return errors;
}

/**
 * Where `document` falls outside the linked-Server-Card subset `generateAICatalog` produces, on top of
 * `aiCatalogErrors`: v0.9 of the AI Catalog specification, and entries that only link a Server Card by a logical identifier, a
 * display name, and its URL, with an optional trust manifest. The display name is optional in the AI Catalog but required
 * by ARD v0.91 ("4.2 Entry Terms"), and the trust manifest is ARD's ("4.5 Trust and Verification"), checked against the
 * `TrustManifest` of its entry schema.
 */
export function linkedCardCatalogErrors(document: unknown): string[] {
  const errors = aiCatalogErrors(document);
  if (errors.length > 0) return errors;
  const catalog = document as { specVersion: string; entries: Record<string, unknown>[] };
  if (catalog.specVersion !== '0.9') errors.push('specVersion is not 0.9');
  const catalogKeys = Object.keys(catalog).join();
  if (catalogKeys !== 'specVersion,entries' && catalogKeys !== 'specVersion,host,entries') {
    errors.push(
      `the catalog has ${catalogKeys}, not just specVersion, an optional host, and entries`,
    );
  }
  // Level 2 (Discoverable Catalog): a host identifying the operator, here always with an identifier, and a
  // documentation URL over https when there is one
  const host = (catalog as { host?: Record<string, unknown> }).host;
  if (host !== undefined) {
    const keys = Object.keys(host).join();
    if (keys !== 'displayName,identifier' && keys !== 'displayName,identifier,documentationUrl')
      errors.push(
        `host has ${keys}, not just displayName, identifier, and an optional documentationUrl`,
      );
    if (!isText(host.displayName) || (host.displayName as string).trim() === '')
      errors.push('host.displayName is not a non-empty name');
    if (!isText(host.identifier) || (host.identifier as string).length === 0)
      errors.push('host.identifier is not non-empty text');
    if (
      host.documentationUrl !== undefined &&
      !(
        isExactHttpUrl(host.documentationUrl as string) &&
        (host.documentationUrl as string).startsWith('https://')
      )
    )
      errors.push('host.documentationUrl is not an https URL');
  }
  catalog.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    const keys = Object.keys(entry).join();
    if (!/^identifier,displayName,type,url(,representativeQueries)?(,trustManifest)?$/.test(keys)) {
      errors.push(
        `${at} has ${keys}, not just identifier, displayName, type, url, and optional representativeQueries and trustManifest`,
      );
    }
    // ARD v0.91 entry schema, EntryFields: representativeQueries is an array of strings
    if (
      entry.representativeQueries !== undefined &&
      !(
        Array.isArray(entry.representativeQueries) &&
        Array.from(entry.representativeQueries).every(
          (query) => isText(query) && (query as string).trim() !== '',
        )
      )
    )
      errors.push(`${at}.representativeQueries is not a list of non-empty text`);
    if (entry.trustManifest !== undefined)
      errors.push(...trustManifestErrors(entry.trustManifest, at));
    if (!isText(entry.displayName) || (entry.displayName as string).trim() === '')
      errors.push(`${at}.displayName is not a non-empty name`);
    // ext-server-card discovery.md, Server Card Entries: type MUST be the Server Card media type
    if (entry.type !== 'application/mcp-server-card+json')
      errors.push(`${at}.type is not a Server Card`);
    const url = entry.url as string;
    if (!isExactHttpUrl(url)) errors.push(`${at}.url is not an exact absolute HTTP URL`);
    else {
      const parsed = new URL(url);
      const loopback =
        /^http:\/\/(?::?@)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d*)?(?:[/?]|$)/i.test(url);
      if (
        (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.hash !== ''
      ) {
        errors.push(`${at}.url is not an allowed Server Card URL`);
      }
    }
    if (entry.identifier === entry.url) errors.push(`${at}.identifier is its url`);
  });
  return errors;
}
