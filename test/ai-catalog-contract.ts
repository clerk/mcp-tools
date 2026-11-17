// An offline check of an AI Catalog against the CDDL schema and prose of the AI Catalog specification, pinned at
// https://github.com/Agent-Card/ai-catalog/blob/4d522ea41c025118e55c7e689b72cc15bf332937/specification/ai-catalog.md.
// That repository publishes no JSON Schema, so this is written from its "CDDL Schema" section, and it has nothing to do
// with the Server Card schema.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown) => typeof value === 'string';

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
  if (document.extensions !== undefined && !isObject(document.extensions)) {
    errors.push('extensions is not a map');
  }
  if (!Array.isArray(document.entries)) return [...errors, 'entries is not an array'];
  document.entries.forEach((entry: unknown, index) => {
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
    if (entry.tags !== undefined && !(Array.isArray(entry.tags) && entry.tags.every(isText))) {
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

/**
 * Where `document` falls outside the linked-Server-Card subset `generateAICatalog` produces, on top of
 * `aiCatalogErrors`: version 1.0, and entries that only link a Server Card by a logical identifier and its URL.
 */
export function linkedCardCatalogErrors(document: unknown): string[] {
  const errors = aiCatalogErrors(document);
  if (errors.length > 0) return errors;
  const catalog = document as { specVersion: string; entries: Record<string, unknown>[] };
  if (catalog.specVersion !== '1.0') errors.push('specVersion is not 1.0');
  if (Object.keys(catalog).join() !== 'specVersion,entries') {
    errors.push(`the catalog has ${Object.keys(catalog).join()}, not just specVersion and entries`);
  }
  catalog.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (Object.keys(entry).join() !== 'identifier,type,url') {
      errors.push(`${at} has ${Object.keys(entry).join()}, not just identifier, type, and url`);
    }
    // ext-server-card discovery.md, Server Card Entries: type MUST be the Server Card media type
    if (entry.type !== 'application/mcp-server-card+json')
      errors.push(`${at}.type is not a Server Card`);
    if (!URL.canParse(entry.url as string)) errors.push(`${at}.url is not a URL`);
    if (entry.identifier === entry.url) errors.push(`${at}.identifier is its url`);
  });
  return errors;
}
