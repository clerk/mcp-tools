import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { generateAICatalog } from './server';
import { aiCatalogErrors, linkedCardCatalogErrors } from './test/ai-catalog-contract';

// The AI Catalog v0.9 RC example at Agent-Card/ai-catalog@19208af (#141; the repo's formatter only rewraps it).
// https://github.com/Agent-Card/ai-catalog/blob/19208af/specification/examples/ai-catalog.json
const upstreamExample = JSON.parse(
  readFileSync(join(import.meta.dirname, 'test/fixtures/ai-catalog.example.json'), 'utf8'),
);
const weather = {
  identifier: 'urn:air:example.com:weather:mcp',
  url: 'https://example.com/mcp/server-card',
};

const CARD_TYPE = 'application/mcp-server-card+json';

describe('generateAICatalog', () => {
  // The Single Server example of ext-server-card@526201b docs/discovery.md, AI Catalog
  test('links one Server Card by its logical identifier and URL', () => {
    expect(
      generateAICatalog({
        entries: [
          {
            identifier: 'urn:air:example.com:weather:mcp',
            url: 'https://example.com/mcp/server-card',
          },
        ],
      }),
    ).toEqual({
      specVersion: '0.9',
      entries: [
        {
          identifier: 'urn:air:example.com:weather:mcp',
          type: CARD_TYPE,
          url: 'https://example.com/mcp/server-card',
        },
      ],
    });
  });

  // The Multiple Servers example of the same document
  test('links several Server Cards in the order they are listed', () => {
    const names = ['code-review', 'docs-search', 'ci-cd'];

    expect(
      generateAICatalog({
        entries: names.map((name) => ({
          identifier: `urn:air:acme.com:${name}:mcp`,
          url: `https://acme.com/${name}/server-card`,
        })),
      }),
    ).toEqual({
      specVersion: '0.9',
      entries: [
        {
          identifier: 'urn:air:acme.com:code-review:mcp',
          type: CARD_TYPE,
          url: 'https://acme.com/code-review/server-card',
        },
        {
          identifier: 'urn:air:acme.com:docs-search:mcp',
          type: CARD_TYPE,
          url: 'https://acme.com/docs-search/server-card',
        },
        {
          identifier: 'urn:air:acme.com:ci-cd:mcp',
          type: CARD_TYPE,
          url: 'https://acme.com/ci-cd/server-card',
        },
      ],
    });
  });

  // For local development only: everywhere else a card URL is https
  test.each([
    'http://localhost:3000/mcp/server-card',
    'http://127.0.0.1:3000/mcp/server-card',
    'http://[::1]:3000/mcp/server-card',
  ])('links a card at the loopback URL %s over http', (url) => {
    expect(generateAICatalog({ entries: [{ ...weather, url }] }).entries[0]?.url).toBe(url);
  });
});

describe('generateAICatalog contract', () => {
  test.each([
    'https://my_host.example/card',
    'https://@example.com/card',
    'https://:@example.com/card',
    'https://@my_host.example/card',
    'https://:@my_host.example/card',
    'https://my~host.example/card',
    'https://my!host.example/card',
    'https://ex%61mple.com/card',
    'https://example.com:/a%20b?next=%2Fexact',
    'https://[::1]:8443/a%20b',
  ])('preserves the accepted URL and passes the independent contract: %s', (url) => {
    const catalog = generateAICatalog({ entries: [{ ...weather, url }] });
    const serialized = JSON.parse(JSON.stringify(catalog));
    expect(serialized.entries[0].url).toBe(url);
    expect(linkedCardCatalogErrors(serialized)).toEqual([]);
  });

  test.each([
    'https://user:password@example.com/card',
    'https://user@example.com/card',
    'https://:password@example.com/card',
    'https://us%65r:p%61ss@example.com/card',
  ])('rejects credentials in the builder and independent contract: %s', (url) => {
    expect(() => generateAICatalog({ entries: [{ ...weather, url }] })).toThrow(
      'Clerk error: generateAICatalog entries[0].url must be',
    );
    expect(
      linkedCardCatalogErrors({
        specVersion: '0.9',
        entries: [{ ...weather, type: CARD_TYPE, url }],
      }),
    ).not.toEqual([]);
  });

  test('generates a catalog the pinned AI Catalog contract accepts, linking cards on other hosts too', () => {
    const catalog = generateAICatalog({
      entries: [
        weather,
        { identifier: 'urn:air:example.com:search:mcp', url: 'https://cards.saas.example/search' },
        { identifier: 'local-dev', url: 'http://localhost:3000/mcp/server-card' },
      ],
    });

    const serialized = JSON.parse(JSON.stringify(catalog));
    expect(aiCatalogErrors(serialized)).toEqual([]);
    expect(linkedCardCatalogErrors(serialized)).toEqual([]);
  });

  // The pinned specification: "This array MAY be empty."
  test('generates an empty catalog the pinned contract accepts', () => {
    const catalog = generateAICatalog({ entries: [] });

    expect(catalog).toEqual({ specVersion: '0.9', entries: [] });
    const serialized = JSON.parse(JSON.stringify(catalog));
    expect(aiCatalogErrors(serialized)).toEqual([]);
    expect(linkedCardCatalogErrors(serialized)).toEqual([]);
  });

  test.each([
    { entries: Object.assign([], { length: 1 }) },
    { entries: Object.assign([weather], { length: 2 }) },
  ])('rejects sparse entries rather than serializing null: %j', ({ entries }) => {
    expect(() => generateAICatalog({ entries } as never)).toThrow(
      'generateAICatalog entries must be a list',
    );
    const sparse = {
      specVersion: '0.9',
      entries: entries.map((entry) => ({ ...entry, type: CARD_TYPE })),
    };
    expect(linkedCardCatalogErrors(sparse)).not.toEqual([]);
    expect(linkedCardCatalogErrors(JSON.parse(JSON.stringify(sparse)))).not.toEqual([]);
  });

  test('the contract check accepts the pinned specification example', () => {
    expect(aiCatalogErrors(upstreamExample)).toEqual([]);
    // It is a catalog, but of other artifacts, with members outside the linked-card subset
    expect(linkedCardCatalogErrors(upstreamExample)).not.toEqual([]);
  });

  // Controls on rules the pinned CDDL itself sets, so a check that accepted everything would fail them
  const valid = {
    specVersion: '0.9',
    entries: [{ ...weather, type: 'application/mcp-server-card+json' }],
  };
  const entry = valid.entries[0]!;
  test.each([
    ['a missing specVersion', { entries: valid.entries }],
    ['a specVersion that is not Major.Minor', { ...valid, specVersion: 'v1' }],
    ['missing entries', { specVersion: '0.9' }],
    [
      'an entry without a type',
      { ...valid, entries: [{ identifier: entry.identifier, url: entry.url }] },
    ],
    ['an entry with a numeric identifier', { ...valid, entries: [{ ...entry, identifier: 1 }] }],
    ['an entry with both url and data', { ...valid, entries: [{ ...entry, data: {} }] }],
    [
      'an entry with neither url nor data',
      { ...valid, entries: [{ identifier: entry.identifier, type: entry.type }] },
    ],
    [
      'a repeated identifier',
      { ...valid, entries: [entry, { ...entry, url: 'https://example.com/b' }] },
    ],
    ['a host without a displayName', { ...valid, host: {} }],
  ])('the contract check rejects %s', (_case, document) => {
    expect(aiCatalogErrors(document)).not.toEqual([]);
  });

  test.each([
    ['another specVersion', { ...valid, specVersion: '1.1' }],
    ['a host', { ...valid, host: { displayName: 'Example' } }],
    [
      'another artifact type',
      { ...valid, entries: [{ ...entry, type: 'application/a2a-agent-card+json' }] },
    ],
    [
      'inline data',
      { ...valid, entries: [{ identifier: entry.identifier, type: entry.type, data: {} }] },
    ],
    ['an identifier that is its url', { ...valid, entries: [{ ...entry, identifier: entry.url }] }],
  ])('the linked-card check rejects %s', (_case, document) => {
    expect(linkedCardCatalogErrors(document)).not.toEqual([]);
  });

  test.each([
    'https:example.com/card',
    'https:/example.com/card',
    'http:localhost/card',
    'https://example.com/{tenant}/card',
    'https://example.com/a%zz',
    'https://example.com/café',
    'https:///example.com/card',
    'https:////example.com/card',
  ])('the linked-card contract rejects a repaired or non-ASCII URL: %s', (url) => {
    expect(linkedCardCatalogErrors({ ...valid, entries: [{ ...entry, url }] })).not.toEqual([]);
  });
});

describe('generateAICatalog options', () => {
  const entries = [weather];

  test('is frozen all the way down, and later changes to the options do not reach it', () => {
    const entry = { ...weather };
    const options = { entries: [entry] };
    const catalog = generateAICatalog(options);
    entry.url = 'https://evil.example/card';
    options.entries.push({
      identifier: 'urn:air:evil.example:x:mcp',
      url: 'https://evil.example/x',
    });

    expect(catalog.entries).toEqual([{ ...weather, type: 'application/mcp-server-card+json' }]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0])).toBe(true);
  });

  test.each([
    ['no options', undefined, 'takes an options object with entries'],
    ['a list for options', [weather], 'takes an options object with entries'],
    ['no entries', {}, 'entries must be a list of { identifier, url }'],
    [
      'an entry that is not an object',
      { entries: ['urn:air:example.com:x:mcp'] },
      'entries must be a list of',
    ],
    ['a specVersion of its own', { entries, specVersion: '0.9' }, 'cannot set specVersion'],
    ['a host', { entries, host: { displayName: 'Example' } }, 'does not take host'],
    ['extensions', { entries, extensions: {} }, 'does not take extensions'],
    ['a signature', { entries, signature: 'x' }, 'does not take signature'],
    [
      'an entry type of its own',
      { entries: [{ ...weather, type: 'application/mcp-server-card+json' }] },
      'cannot set entries[0].type',
    ],
    [
      'an inline document',
      { entries: [{ identifier: weather.identifier, data: {} }] },
      'entries[0] does not take data',
    ],
    [
      'a trust manifest',
      { entries: [{ ...weather, trustManifest: {} }] },
      'entries[0] does not take trustManifest',
    ],
    [
      'entry extensions',
      { entries: [{ ...weather, extensions: {} }] },
      'entries[0] does not take extensions',
    ],
    [
      'an entry version',
      { entries: [{ ...weather, version: '1.0.0' }] },
      'entries[0] does not take version',
    ],
    ['a missing identifier', { entries: [{ url: weather.url }] }, 'entries[0].identifier must be'],
    [
      'an empty identifier',
      { entries: [{ ...weather, identifier: '' }] },
      'entries[0].identifier must be',
    ],
    [
      'an identifier with a space',
      { entries: [{ ...weather, identifier: 'urn:air:example.com:x y:mcp' }] },
      'entries[0].identifier must be',
    ],
    [
      'a numeric identifier',
      { entries: [{ ...weather, identifier: 1 }] },
      'entries[0].identifier must be',
    ],
    [
      'an identifier that is a URL',
      { entries: [{ ...weather, identifier: weather.url }] },
      'entries[0].identifier must be',
    ],
    [
      'a repeated identifier',
      { entries: [weather, { ...weather, url: 'https://example.com/b' }] },
      'entries lists the identifier urn:air:example.com:weather:mcp more than once',
    ],
    ['a missing url', { entries: [{ identifier: weather.identifier }] }, 'entries[0].url must be'],
    [
      'a relative url',
      { entries: [{ ...weather, url: '/mcp/server-card' }] },
      'entries[0].url must be',
    ],
    [
      'an http url off a loopback host',
      { entries: [{ ...weather, url: 'http://example.com/card' }] },
      'entries[0].url must be an absolute https URL',
    ],
    [
      'an http url on a localhost subdomain',
      { entries: [{ ...weather, url: 'http://app.localhost/card' }] },
      'entries[0].url must be an absolute https URL',
    ],
    [
      'an http url on another loopback address',
      { entries: [{ ...weather, url: 'http://127.0.0.2/card' }] },
      'entries[0].url must be an absolute https URL',
    ],
    [
      'a url of another scheme',
      { entries: [{ ...weather, url: 'ftp://example.com/card' }] },
      'entries[0].url must be',
    ],
    [
      'a url with credentials',
      { entries: [{ ...weather, url: 'https://user:pass@example.com/card' }] },
      'entries[0].url must be',
    ],
    [
      'a url with a fragment',
      { entries: [{ ...weather, url: 'https://example.com/card#x' }] },
      'entries[0].url must be',
    ],
    [
      'a url with a space',
      { entries: [{ ...weather, url: 'https://example.com/a card' }] },
      'entries[0].url must be',
    ],
    [
      'a second entry that is wrong',
      { entries: [weather, { identifier: 'urn:air:example.com:b:mcp', url: 7 }] },
      'entries[1].url must be',
    ],
  ])('rejects %s', (_case, options, message) => {
    expect(() => generateAICatalog(options as never)).toThrow(
      `Clerk error: generateAICatalog ${message}`,
    );
  });

  test.each([
    'https:example.com/card',
    'https:/example.com/card',
    'http:localhost/card',
    'https://example.com/{tenant}/card',
    'https://example.com/a%zz',
    'https://example.com/café',
    'https:///example.com/card',
    'https:////example.com/card',
  ])('rejects a non-exact URL %s', (url) => {
    expect(() => generateAICatalog({ entries: [{ ...weather, url }] })).toThrow(
      'Clerk error: generateAICatalog entries[0].url must be',
    );
  });
});
