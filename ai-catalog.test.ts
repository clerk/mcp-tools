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
  displayName: 'Weather',
  url: 'https://example.com/mcp/server-card',
};

const CARD_TYPE = 'application/mcp-server-card+json';
const loopbackAliases = ['127.1', '2130706433', '0x7f.0.0.1', '[0:0:0:0:0:0:0:1]'];

const trustManifest = {
  identity: 'https://example.com',
  identityType: 'https',
  attestations: [
    {
      type: 'SOC2-Type2',
      uri: 'https://example.com/compliance/soc2.pdf',
      digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      mediaType: 'application/pdf',
    },
  ],
};

describe('generateAICatalog', () => {
  // The Single Server example of ext-server-card@526201b docs/discovery.md, AI Catalog
  test('links one Server Card by its logical identifier and URL', () => {
    expect(
      generateAICatalog({
        entries: [
          {
            identifier: 'urn:air:example.com:weather:mcp',
            displayName: 'Weather',
            url: 'https://example.com/mcp/server-card',
          },
        ],
      }),
    ).toEqual({
      specVersion: '0.9',
      entries: [
        {
          identifier: 'urn:air:example.com:weather:mcp',
          displayName: 'Weather',
          type: CARD_TYPE,
          url: 'https://example.com/mcp/server-card',
          // ARD v0.91 4.5.1: the default trust manifest of a urn:air:example.com identifier
          trustManifest: { identity: 'https://example.com', identityType: 'https' },
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
          displayName: name,
          url: `https://acme.com/${name}/server-card`,
        })),
      }),
    ).toEqual({
      specVersion: '0.9',
      entries: [
        {
          identifier: 'urn:air:acme.com:code-review:mcp',
          displayName: 'code-review',
          type: CARD_TYPE,
          url: 'https://acme.com/code-review/server-card',
          trustManifest: { identity: 'https://acme.com', identityType: 'https' },
        },
        {
          identifier: 'urn:air:acme.com:docs-search:mcp',
          displayName: 'docs-search',
          type: CARD_TYPE,
          url: 'https://acme.com/docs-search/server-card',
          trustManifest: { identity: 'https://acme.com', identityType: 'https' },
        },
        {
          identifier: 'urn:air:acme.com:ci-cd:mcp',
          displayName: 'ci-cd',
          type: CARD_TYPE,
          url: 'https://acme.com/ci-cd/server-card',
          trustManifest: { identity: 'https://acme.com', identityType: 'https' },
        },
      ],
    });
  });

  // For local development only: everywhere else a card URL is https
  test.each(
    ['localhost', 'LOCALhost', '127.0.0.1', '[::1]'].flatMap((host) =>
      ['', ':3000'].map((port) => `http://${host}${port}/mcp/server-card`),
    ),
  )('links a card at the literal loopback URL %s over http', (url) => {
    const catalog = generateAICatalog({ entries: [{ ...weather, url }] });
    expect(catalog.entries[0]?.url).toBe(url);
    expect(linkedCardCatalogErrors(JSON.parse(JSON.stringify(catalog)))).toEqual([]);
  });

  test.each(
    loopbackAliases.flatMap((host) => ['', ':3000'].map((port) => `http://${host}${port}/card`)),
  )('rejects a normalized loopback alias in the builder and independent contract: %s', (url) => {
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
});

describe('generateAICatalog contract', () => {
  test.each([
    ...loopbackAliases.map((host) => `https://${host}/card`),
    'http://@localhost:3000/card',
    'http://:@[::1]/card',
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

  // ARD v0.91, 4.5 Trust and Verification: an entry may carry a trustManifest, which needs only an identity
  test('carries an entry trustManifest as given, and none for null', () => {
    expect(
      generateAICatalog({
        entries: [
          { ...weather, trustManifest },
          {
            identifier: 'urn:air:example.com:search:mcp',
            displayName: 'Search',
            url: 'https://example.com/search/server-card',
            trustManifest: {
              identity: 'did:web:example.com',
              attestations: [{ type: 'ISO27001', uri: 'data:text/plain;base64,SVNPMjcwMDE=' }],
            },
          },
          {
            identifier: 'urn:air:example.com:docs:mcp',
            displayName: 'Docs',
            url: 'https://example.com/docs/server-card',
            trustManifest: null,
          },
        ],
      }),
    ).toEqual({
      specVersion: '0.9',
      entries: [
        {
          identifier: 'urn:air:example.com:weather:mcp',
          displayName: 'Weather',
          type: CARD_TYPE,
          url: 'https://example.com/mcp/server-card',
          trustManifest: {
            identity: 'https://example.com',
            identityType: 'https',
            attestations: [
              {
                type: 'SOC2-Type2',
                uri: 'https://example.com/compliance/soc2.pdf',
                digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
                mediaType: 'application/pdf',
              },
            ],
          },
        },
        {
          identifier: 'urn:air:example.com:search:mcp',
          displayName: 'Search',
          type: CARD_TYPE,
          url: 'https://example.com/search/server-card',
          trustManifest: {
            identity: 'did:web:example.com',
            attestations: [{ type: 'ISO27001', uri: 'data:text/plain;base64,SVNPMjcwMDE=' }],
          },
        },
        {
          identifier: 'urn:air:example.com:docs:mcp',
          displayName: 'Docs',
          type: CARD_TYPE,
          url: 'https://example.com/docs/server-card',
        },
      ],
    });
  });

  test('generates a catalog the pinned AI Catalog contract accepts, linking cards on other hosts too', () => {
    const catalog = generateAICatalog({
      entries: [
        { ...weather, trustManifest },
        {
          identifier: 'urn:air:example.com:search:mcp',
          displayName: 'Search',
          url: 'https://cards.saas.example/search',
        },
        {
          identifier: 'local-dev',
          displayName: 'Local development',
          url: 'http://localhost:3000/mcp/server-card',
        },
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
    [
      'an entry without a displayName',
      { ...valid, entries: [{ identifier: entry.identifier, type: entry.type, url: entry.url }] },
    ],
    ['an empty displayName', { ...valid, entries: [{ ...entry, displayName: '' }] }],
    ['a whitespace displayName', { ...valid, entries: [{ ...entry, displayName: ' ' }] }],
    // ARD v0.91 entry schema, TrustManifest: identity is required, and each attestation needs a type and a uri
    [
      'a trustManifest without an identity',
      { ...valid, entries: [{ ...entry, trustManifest: {} }] },
    ],
    [
      'a trustManifest with a numeric identityType',
      {
        ...valid,
        entries: [
          { ...entry, trustManifest: { identity: 'https://example.com', identityType: 1 } },
        ],
      },
    ],
    [
      'attestations that are not a list',
      { ...valid, entries: [{ ...entry, trustManifest: { ...trustManifest, attestations: {} } }] },
    ],
    [
      'an attestation without a uri',
      {
        ...valid,
        entries: [
          { ...entry, trustManifest: { ...trustManifest, attestations: [{ type: 'SOC2-Type2' }] } },
        ],
      },
    ],
    [
      'an attestation with a numeric mediaType',
      {
        ...valid,
        entries: [
          {
            ...entry,
            trustManifest: {
              ...trustManifest,
              attestations: [{ type: 'SOC2-Type2', uri: 'https://example.com/soc2', mediaType: 1 }],
            },
          },
        ],
      },
    ],
    [
      'a trustManifest before the url',
      {
        ...valid,
        entries: [
          {
            identifier: entry.identifier,
            displayName: entry.displayName,
            type: entry.type,
            trustManifest,
            url: entry.url,
          },
        ],
      },
    ],
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
      displayName: 'Evil',
      url: 'https://evil.example/x',
    });

    expect(catalog.entries).toEqual([
      {
        ...weather,
        type: 'application/mcp-server-card+json',
        trustManifest: { identity: 'https://example.com', identityType: 'https' },
      },
    ]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0]?.trustManifest)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0])).toBe(true);
  });

  test.each([
    ['no options', undefined, 'takes an options object with entries'],
    ['a list for options', [weather], 'takes an options object with entries'],
    ['no entries', {}, 'entries must be a list of { identifier, displayName, url }'],
    [
      'an entry that is not an object',
      { entries: ['urn:air:example.com:x:mcp'] },
      'entries must be a list of',
    ],
    ['a specVersion of its own', { entries, specVersion: '0.9' }, 'cannot set specVersion'],
    ['a host without an identifier', { entries, host: { displayName: 'Example' } }, 'host must be'],
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
    ...(
      [
        ['a trust manifest without an identity', {}],
        ['a trust manifest that is a list', [trustManifest]],
        ['a trust manifest identity that is not a URI', { identity: 'example.com' }],
        ['a trust manifest identity with a space', { identity: 'https://example.com/a b' }],
        // A publisher's identity is a name, never a script, inline content, a local file, or plain http
        ...[
          'javascript:alert(1)',
          'JavaScript:alert(1)',
          'data:,example.com',
          'file:///etc/passwd',
          'http://example.com',
          // Credentials in a URL would be published in a public, cached catalog
          'https://user:password@example.com/',
          'https://user@example.com/',
          'HTTPS://user:password@example.com/',
        ].map((identity) => [`a trust manifest identity ${identity}`, { identity }] as const),
        ['a numeric identityType', { identity: 'https://example.com', identityType: 1 }],
        ['an empty identityType', { identity: 'https://example.com', identityType: '' }],
        ['attestations that are not a list', { ...trustManifest, attestations: {} }],
        [
          'a sparse attestation list',
          { ...trustManifest, attestations: Object.assign([], { length: 1 }) },
        ],
        [
          'an attestation without a uri',
          { ...trustManifest, attestations: [{ type: 'SOC2-Type2' }] },
        ],
        [
          'an attestation with a relative uri',
          { ...trustManifest, attestations: [{ type: 'SOC2-Type2', uri: '/soc2.pdf' }] },
        ],
        // AI Catalog RC, Attestation Object: the uri "may be an HTTPS URL or an inline Data URI"
        ...[
          'javascript:alert(1)',
          'http://example.com/soc2.pdf',
          'http://localhost:3000/soc2.pdf',
          'file:///soc2.pdf',
          'ftp://example.com/soc2.pdf',
          'https:example.com/soc2.pdf',
          'https://user:pass@example.com/soc2.pdf',
          'did:web:example.com',
        ].map(
          (uri) =>
            [
              `an attestation with the uri ${uri}`,
              { ...trustManifest, attestations: [{ type: 'SOC2-Type2', uri }] },
            ] as const,
        ),
        [
          'an attestation with an empty type',
          { ...trustManifest, attestations: [{ type: ' ', uri: 'https://example.com/soc2' }] },
        ],
        [
          'an attestation with a numeric digest',
          {
            ...trustManifest,
            attestations: [{ type: 'SOC2-Type2', uri: 'https://example.com/soc2', digest: 1 }],
          },
        ],
        [
          'an attestation with an unsupported key',
          {
            ...trustManifest,
            attestations: [{ type: 'SOC2-Type2', uri: 'https://example.com/soc2', size: 1 }],
          },
        ],
        ['a trust manifest signature', { ...trustManifest, signature: 'eyJ' }],
        ['a trust schema', { ...trustManifest, trustSchema: {} }],
      ] as const
    ).map(([name, manifest]): [string, unknown, string] => [
      name,
      { entries: [{ ...weather, trustManifest: manifest }] },
      'entries[0].trustManifest must be',
    ]),
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
    [
      'a missing displayName',
      { entries: [{ identifier: weather.identifier, url: weather.url }] },
      'entries[0].displayName must be',
    ],
    [
      'an empty displayName',
      { entries: [{ ...weather, displayName: '' }] },
      'entries[0].displayName must be',
    ],
    [
      'a whitespace displayName',
      { entries: [{ ...weather, displayName: ' \t' }] },
      'entries[0].displayName must be',
    ],
    [
      'a numeric displayName',
      { entries: [{ ...weather, displayName: 1 }] },
      'entries[0].displayName must be',
    ],
    [
      'a displayName with a control character',
      { entries: [{ ...weather, displayName: 'Weather\n' }] },
      'entries[0].displayName must be',
    ],
    [
      'a missing url',
      { entries: [{ identifier: weather.identifier, displayName: weather.displayName }] },
      'entries[0].url must be',
    ],
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
      { entries: [weather, { identifier: 'urn:air:example.com:b:mcp', displayName: 'B', url: 7 }] },
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

// ARD v0.91, 4.2 Entry Terms: representativeQueries SHOULD carry 2-5 sample queries; the AI Catalog v0.9 RC, Host Info
// and Level 2 (Discoverable Catalog): a host identifies the catalog's operator
describe('generateAICatalog representativeQueries and host', () => {
  const representativeQueries = ['What is the weather in Paris?', 'Will it rain tomorrow?'];
  const host = {
    displayName: 'Example Inc.',
    identifier: 'did:web:example.com',
    documentationUrl: 'https://docs.example.com/agents',
  };

  test('emits them where they were set, in document order, and passes the contract', () => {
    const catalog = generateAICatalog({
      host,
      entries: [
        { ...weather, representativeQueries },
        { ...weather, identifier: 'urn:air:x' },
      ],
    });
    const serialized = JSON.parse(JSON.stringify(catalog));

    expect(Object.keys(serialized)).toEqual(['specVersion', 'host', 'entries']);
    expect(serialized.host).toEqual(host);
    expect(serialized.entries[0]).toMatchObject({
      ...weather,
      type: CARD_TYPE,
      representativeQueries,
    });
    expect(Object.keys(serialized.entries[0]).slice(0, 5)).toEqual([
      'identifier',
      'displayName',
      'type',
      'url',
      'representativeQueries',
    ]);
    expect(serialized.entries[1]).not.toHaveProperty('representativeQueries');
    expect(aiCatalogErrors(serialized)).toEqual([]);
    expect(linkedCardCatalogErrors(serialized)).toEqual([]);
  });

  test('emits a host without a documentationUrl, and neither member when they are omitted', () => {
    const withHost = generateAICatalog({
      host: { displayName: 'Example', identifier: 'example.com' },
      entries: [],
    });
    expect(withHost).toEqual({
      specVersion: '0.9',
      host: { displayName: 'Example', identifier: 'example.com' },
      entries: [],
    });
    expect(linkedCardCatalogErrors(JSON.parse(JSON.stringify(withHost)))).toEqual([]);
    expect(generateAICatalog({ entries: [] })).toEqual({ specVersion: '0.9', entries: [] });
  });

  // ARD v0.91 4.2 and D.2 enforce no count, but an empty list carries nothing, so it is rejected rather than emitted
  test('rejects an empty list of representativeQueries', () => {
    expect(() =>
      generateAICatalog({ entries: [{ ...weather, representativeQueries: [] }] }),
    ).toThrow(
      'Clerk error: generateAICatalog entries[0].representativeQueries must be a list of 1 to 20 sample requests',
    );
  });

  test('copies them, so changing the options later changes nothing', () => {
    const queries = [...representativeQueries];
    const ownHost = { ...host };
    const catalog = generateAICatalog({
      host: ownHost,
      entries: [{ ...weather, representativeQueries: queries }],
    });
    queries.push('changed');
    ownHost.displayName = 'changed';

    expect(catalog.entries[0]?.representativeQueries).toEqual(representativeQueries);
    expect(catalog.host?.displayName).toBe('Example Inc.');
    expect(Object.isFrozen(catalog.entries[0]?.representativeQueries)).toBe(true);
    expect(Object.isFrozen(catalog.host)).toBe(true);
  });

  test.each([
    ['not a list', 'What is the weather?'],
    ['an empty query', ['']],
    ['a blank query', ['   ']],
    ['a query with a control character', ['a\x00b']],
    ['a query that is not text', [42]],
    ['a sparse list', Object.assign(['a'], { length: 2 })],
    ['more than 20 queries', Array.from({ length: 21 }, (_, i) => `query ${i}`)],
  ])('rejects representativeQueries that is %s', (_case, value) => {
    expect(() =>
      generateAICatalog({ entries: [{ ...weather, representativeQueries: value as never }] }),
    ).toThrow('Clerk error: generateAICatalog entries[0].representativeQueries must be');
  });

  test.each([
    ['not an object', 'Example'],
    ['without a displayName', { identifier: 'example.com' }],
    ['without an identifier', { displayName: 'Example' }],
    ['with a blank displayName', { displayName: ' ', identifier: 'example.com' }],
    ['with an identifier holding a space', { displayName: 'Example', identifier: 'example com' }],
    [
      'with an http documentationUrl',
      {
        displayName: 'Example',
        identifier: 'example.com',
        documentationUrl: 'http://docs.example.com',
      },
    ],
    [
      'with a relative documentationUrl',
      { displayName: 'Example', identifier: 'example.com', documentationUrl: '/docs' },
    ],
    [
      'with credentials in its documentationUrl',
      {
        displayName: 'Example',
        identifier: 'example.com',
        documentationUrl: 'https://user:pass@docs.example.com',
      },
    ],
    ['with a logoUrl', { displayName: 'Example', identifier: 'example.com', logoUrl: 'https://x' }],
  ])('rejects a host %s', (_case, value) => {
    expect(() => generateAICatalog({ host: value as never, entries: [] })).toThrow(
      'Clerk error: generateAICatalog host must be',
    );
  });

  test('the contract rejects a host without a displayName and queries that are not text', () => {
    expect(
      linkedCardCatalogErrors({ specVersion: '0.9', host: { identifier: 'x' }, entries: [] }),
    ).not.toEqual([]);
    expect(
      linkedCardCatalogErrors({
        specVersion: '0.9',
        entries: [{ ...weather, type: CARD_TYPE, representativeQueries: [1] }],
      }),
    ).not.toEqual([]);
  });
});

// ARD v0.91, 4.5.1 Publisher Authority Binding: "The cryptographic trust domain asserted in trustManifest.identity
// MUST align with the <publisher> domain embedded in the entry's discovery identifier", which Appendix C makes a fully
// qualified domain name in urn:air:<publisher>:[<namespace>:]<agent-name>
describe('generateAICatalog trust manifest default', () => {
  const entry = (identifier: string, rest: object = {}) => ({
    identifier,
    displayName: 'X',
    url: 'https://example.com/mcp/server-card',
    ...rest,
  });
  const only = (options: object) => generateAICatalog({ entries: [options as never] }).entries[0];

  test.each([
    ['urn:air:example.com:x', 'https://example.com'],
    ['urn:air:mcp.example.com:finance:trading:trader', 'https://mcp.example.com'],
    ['urn:air:Example.COM:x', 'https://example.com'],
    ['URN:AIR:example.com:x', 'https://example.com'],
  ])('defaults the trust manifest of %s to the https identity %s', (identifier, identity) => {
    const linked = only(entry(identifier));

    expect(linked?.trustManifest).toEqual({ identity, identityType: 'https' });
    expect(linked && linkedCardCatalogErrors({ specVersion: '0.9', entries: [linked] })).toEqual(
      [],
    );
  });

  test('publishes none for trustManifest: null', () => {
    expect(only(entry('urn:air:example.com:x', { trustManifest: null }))).not.toHaveProperty(
      'trustManifest',
    );
  });

  test('emits an explicit trust manifest as given', () => {
    const trustManifest = { identity: 'did:web:example.com' };
    expect(only(entry('urn:air:example.com:x', { trustManifest }))?.trustManifest).toEqual(
      trustManifest,
    );
  });

  test.each([
    'did:web:example.com',
    'weather',
    'urn:air:example.com',
    'urn:air:example.com:',
    'urn:air:localhost:x',
    'urn:air:user@evil.com:x',
    'urn:air:exa_mple.com:x',
    'urn:air:-example.com:x',
    'urn:air:example..com:x',
    'urn:air:127.0.0.1:x',
    'urn:other:example.com:x',
  ])('defaults no trust manifest for %s, whose publisher is not a domain name', (identifier) => {
    expect(only(entry(identifier))).not.toHaveProperty('trustManifest');
  });

  test('defaults the manifest of each entry from its own identifier', () => {
    const { entries } = generateAICatalog({
      entries: [entry('urn:air:example.com:a'), entry('urn:air:saas.example:b')],
    });
    expect(entries.map((linked) => linked.trustManifest?.identity)).toEqual([
      'https://example.com',
      'https://saas.example',
    ]);
  });
});
