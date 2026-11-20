import { describe, expect, test } from 'vitest';
import { generateServerCard } from './server';
import { validateServerCard } from './test/server-card-schema';

const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
const required = {
  name: 'com.example/weather',
  version: '1.2.0',
  description: 'Forecasts and current conditions.',
  resourceUrl: 'https://mcp.example.com/mcp',
};

describe('generateServerCard', () => {
  test('generates a card the pinned ServerCard definition accepts, with a static streamable HTTP remote', () => {
    const card = generateServerCard({
      ...required,
      title: 'Weather',
      websiteUrl: 'https://example.com/docs/mcp',
      icons: [
        {
          src: 'https://example.com/icon.png',
          mimeType: 'image/png',
          sizes: ['48x48'],
          theme: 'light',
        },
      ],
      repository: {
        url: 'https://github.com/example/weather',
        source: 'github',
        subfolder: 'server',
        id: '42',
      },
      _meta: { 'com.example/tier': { plan: 'free', limits: [1, 2.5, null, true] } },
    });

    expect(card).toEqual({
      $schema: SCHEMA_URL,
      name: 'com.example/weather',
      version: '1.2.0',
      description: 'Forecasts and current conditions.',
      title: 'Weather',
      websiteUrl: 'https://example.com/docs/mcp',
      repository: {
        url: 'https://github.com/example/weather',
        source: 'github',
        subfolder: 'server',
        id: '42',
      },
      icons: [
        {
          src: 'https://example.com/icon.png',
          mimeType: 'image/png',
          sizes: ['48x48'],
          theme: 'light',
        },
      ],
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      _meta: { 'com.example/tier': { plan: 'free', limits: [1, 2.5, null, true] } },
    });
    expect(
      validateServerCard(JSON.parse(JSON.stringify(card))),
      JSON.stringify(validateServerCard.errors),
    ).toBe(true);
    expect(validateServerCard(JSON.parse(JSON.stringify(generateServerCard(required))))).toBe(true);
  });

  test.each([128, 255])('accepts a version with %i astral code points', (length) => {
    const version = '🚀'.repeat(length);
    const card = generateServerCard({ ...required, version });
    expect(card.version).toBe(version);
    expect(
      validateServerCard(JSON.parse(JSON.stringify(card))),
      JSON.stringify(validateServerCard.errors),
    ).toBe(true);
  });

  test('rejects a version with 256 astral code points', () => {
    const version = '🚀'.repeat(256);
    expect(() => generateServerCard({ ...required, version })).toThrow(
      'version must be 1 to 255 characters',
    );
    const candidate = { ...generateServerCard(required), version };
    expect(validateServerCard(JSON.parse(JSON.stringify(candidate)))).toBe(false);
    expect(validateServerCard.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'maxLength', instancePath: '/version' }),
      ]),
    );
  });

  test.each(['packages/server', 'packages/@scope/server', 'packages/server.v2'])(
    'preserves a clean repository-relative subfolder: %s',
    (subfolder) => {
      const repository = { url: 'https://github.com/example/weather', source: 'github', subfolder };
      const card = generateServerCard({ ...required, repository });
      expect(card.repository).toEqual(repository);
      expect(validateServerCard(JSON.parse(JSON.stringify(card)))).toBe(true);
    },
  );

  test.each([
    '',
    '.',
    '..',
    './packages/server',
    '../outside',
    'packages/./server',
    'packages/../server',
    '/packages/server',
    'packages/server/',
    'packages//server',
    '//other.example/server',
    'https://other.example/server',
    'mailto:server@example.com',
    'C:/packages/server',
    'C:packages/server',
    'packages\\server',
    '\\\\host\\server',
  ])('rejects an unclean repository subfolder: %j', (subfolder) => {
    expect(() =>
      generateServerCard({
        ...required,
        repository: { url: 'https://github.com/example/weather', source: 'github', subfolder },
      }),
    ).toThrow('generateServerCard repository');
  });

  test.each(['description', 'title'] as const)('counts %s by Unicode code points', (key) => {
    const card = generateServerCard({ ...required, [key]: '🌤'.repeat(100) });
    expect(card[key]).toBe('🌤'.repeat(100));
    expect(validateServerCard(JSON.parse(JSON.stringify(card)))).toBe(true);
    expect(() => generateServerCard({ ...required, [key]: '🌤'.repeat(101) })).toThrow(
      `${key} must be 1 to 100 characters`,
    );
  });

  test.each([
    'https://example.com/mcp?key=a%20b&next=%2Fexact#section',
    'https://[::1]:8443/a%20b?x=y/z?x',
    'HTTPS://EXAMPLE.COM/a%20b',
  ])('preserves valid optional URI strings in schema-valid serialized output: %s', (url) => {
    const card = generateServerCard({
      ...required,
      websiteUrl: url,
      icons: [{ src: url }],
      repository: { url, source: 'git' },
    });
    expect(card.websiteUrl).toBe(url);
    expect(card.icons?.[0]?.src).toBe(url);
    expect(card.repository?.url).toBe(url);
    expect(
      validateServerCard(JSON.parse(JSON.stringify(card))),
      JSON.stringify(validateServerCard.errors),
    ).toBe(true);
  });

  test('preserves an encoded endpoint exactly in schema-valid serialized output', () => {
    const resourceUrl = 'https://example.com/a%20b?next=%2Fexact&x=1';
    const card = generateServerCard({ ...required, resourceUrl });
    expect(card.remotes[0]?.url).toBe(resourceUrl);
    expect(validateServerCard(JSON.parse(JSON.stringify(card)))).toBe(true);
  });

  test.each(['HTTPS://example.com/mcp', 'https:example.com/mcp'])(
    'rejects a remote URL outside the pinned pattern: %s',
    (resourceUrl) => {
      expect(() => generateServerCard({ ...required, resourceUrl })).toThrow(
        'generateServerCard resourceUrl',
      );
    },
  );

  test.each([
    'https://example.com/a b',
    'https://example.com/a\tb',
    'https://example.com/a\nb',
    'https://example.com/a%zz',
    'https://example.com/a[b]',
    'https://example.com/café',
    'https://example.com/a\\b',
    'https://example.com/end\n',
    'https://example.com/a\0b',
  ])('rejects a raw non-URI string in every optional URI field: %s', (url) => {
    for (const options of [
      { websiteUrl: url },
      { icons: [{ src: url }] },
      { repository: { url, source: 'git' } },
    ]) {
      expect(() => generateServerCard({ ...required, ...options })).toThrow(
        'Clerk error: generateServerCard',
      );
    }
  });

  test.each(['data:image/svg+xml,<svg> </svg>', 'data:image/png;base64,a b'])(
    'rejects a non-URI data icon: %s',
    (src) => {
      expect(() => generateServerCard({ ...required, icons: [{ src }] })).toThrow(
        'generateServerCard icons',
      );
    },
  );

  test.each([
    { icons: Object.assign([], { length: 1 }) },
    { icons: Object.assign([{ src: 'https://example.com/icon.png' }], { length: 2 }) },
    { icons: [{ src: 'https://example.com/icon.png', sizes: Object.assign([], { length: 1 }) }] },
    {
      icons: [
        { src: 'https://example.com/icon.png', sizes: Object.assign(['48x48'], { length: 2 }) },
      ],
    },
  ])('rejects missing array positions instead of serializing null: %j', (options) => {
    expect(() => generateServerCard({ ...required, ...options } as never)).toThrow(
      'generateServerCard icons',
    );
  });

  // Controls on constraints the schema itself enforces, so a validator that accepted everything would fail them
  test.each([
    [
      'a missing $schema',
      (card: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(card).filter(([key]) => key !== '$schema')),
    ],
    [
      'a dated $schema',
      (card: Record<string, unknown>) => ({
        ...card,
        $schema:
          'https://static.modelcontextprotocol.io/schemas/2025-01-01/server-card.schema.json',
      }),
    ],
    ['a name without a slash', (card: Record<string, unknown>) => ({ ...card, name: 'weather' })],
    [
      'a missing name',
      (card: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(card).filter(([key]) => key !== 'name')),
    ],
    [
      'a long description',
      (card: Record<string, unknown>) => ({ ...card, description: 'x'.repeat(101) }),
    ],
    [
      'a websiteUrl that is not a URI',
      (card: Record<string, unknown>) => ({ ...card, websiteUrl: 'not a uri' }),
    ],
  ])('the pinned definition rejects a card with %s', (_name, change) => {
    const card = change({ ...generateServerCard(required) });
    expect(validateServerCard(card)).toBe(false);
  });
});

describe('generateServerCard options', () => {
  test.each<[string, unknown, string]>([
    ['an options value that is not an object', null, 'generateServerCard takes an options object'],
    ['an array', [], 'generateServerCard takes an options object'],
    ['an unknown key', { ...required, tools: [] }, 'generateServerCard does not take tools'],
    [
      'a $schema of its own',
      { ...required, $schema: SCHEMA_URL },
      'generateServerCard cannot set $schema',
    ],
    [
      'a $schema key set to undefined',
      { ...required, $schema: undefined },
      'generateServerCard cannot set $schema',
    ],
    ['remotes of its own', { ...required, remotes: [] }, 'generateServerCard cannot set remotes'],
    ['no name', { ...required, name: undefined }, 'generateServerCard name'],
    ['a name without a namespace', { ...required, name: 'weather' }, 'generateServerCard name'],
    [
      'a name with two slashes',
      { ...required, name: 'com.example/a/b' },
      'generateServerCard name',
    ],
    [
      'a name over 200 characters',
      { ...required, name: `com.example/${'a'.repeat(190)}` },
      'generateServerCard name',
    ],
    ['no version', { ...required, version: undefined }, 'generateServerCard version'],
    ['an empty version', { ...required, version: '' }, 'generateServerCard version'],
    [
      'a version over 255 characters',
      { ...required, version: '1'.repeat(256) },
      'generateServerCard version',
    ],
    ...[
      '^1.2.3',
      '~1.2.3',
      '>=1.2.3',
      '1.x',
      '1.*',
      'x',
      '1.2.3 - 2.0.0',
      '1.2.3  -   2.0.0',
      '1.2.3\t-\t2.0.0',
      '1 || 2',
    ].map((version): [string, unknown, string] => [
      `the version range ${version}`,
      { ...required, version },
      'generateServerCard version',
    ]),
    ['no description', { ...required, description: undefined }, 'generateServerCard description'],
    ['an empty description', { ...required, description: '' }, 'generateServerCard description'],
    [
      'a description over 100 characters',
      { ...required, description: 'x'.repeat(101) },
      'generateServerCard description',
    ],
    ['an empty title', { ...required, title: '' }, 'generateServerCard title'],
    [
      'a title over 100 characters',
      { ...required, title: 'x'.repeat(101) },
      'generateServerCard title',
    ],
    [
      'a websiteUrl that is not a URL',
      { ...required, websiteUrl: 'docs' },
      'generateServerCard websiteUrl',
    ],
    [
      'a javascript: websiteUrl',
      { ...required, websiteUrl: 'javascript:alert(1)' },
      'generateServerCard websiteUrl',
    ],
    ['no resourceUrl', { ...required, resourceUrl: undefined }, 'generateServerCard resourceUrl'],
    [
      'a list of resourceUrls',
      { ...required, resourceUrl: [required.resourceUrl] },
      'generateServerCard resourceUrl',
    ],
    [
      'a relative resourceUrl',
      { ...required, resourceUrl: '/mcp' },
      'generateServerCard resourceUrl',
    ],
    [
      'a resourceUrl with credentials',
      { ...required, resourceUrl: 'https://u:p@mcp.example.com/mcp' },
      'generateServerCard resourceUrl',
    ],
    [
      'a resourceUrl with a fragment',
      { ...required, resourceUrl: 'https://mcp.example.com/mcp#x' },
      'generateServerCard resourceUrl',
    ],
    [
      'a templated resourceUrl',
      { ...required, resourceUrl: 'https://mcp.example.com/{tenant}/mcp' },
      'generateServerCard resourceUrl',
    ],
    [
      'a resourceUrl with a space',
      { ...required, resourceUrl: 'https://mcp.example.com/m cp' },
      'generateServerCard resourceUrl',
    ],
    [
      'icons that are not a list',
      { ...required, icons: { src: 'https://example.com/i.png' } },
      'generateServerCard icons',
    ],
    [
      'an icon without src',
      { ...required, icons: [{ mimeType: 'image/png' }] },
      'generateServerCard icons',
    ],
    [
      'an icon with a javascript: src',
      { ...required, icons: [{ src: 'javascript:alert(1)' }] },
      'generateServerCard icons',
    ],
    [
      'an icon with an unknown key',
      { ...required, icons: [{ src: 'https://example.com/i.png', alt: 'x' }] },
      'generateServerCard icons',
    ],
    [
      'an icon with an unknown theme',
      { ...required, icons: [{ src: 'https://example.com/i.png', theme: 'blue' }] },
      'generateServerCard icons',
    ],
    [
      'an icon with sizes that are not strings',
      { ...required, icons: [{ src: 'https://example.com/i.png', sizes: [48] }] },
      'generateServerCard icons',
    ],
    [
      'a repository without source',
      { ...required, repository: { url: 'https://github.com/example/weather' } },
      'generateServerCard repository',
    ],
    [
      'a repository with an unknown key',
      { ...required, repository: { url: 'https://github.com/x/y', source: 'github', token: 't' } },
      'generateServerCard repository',
    ],
    [
      'a repository url that is not a URL',
      { ...required, repository: { url: 'weather', source: 'github' } },
      'generateServerCard repository',
    ],
    ['a _meta that is not an object', { ...required, _meta: ['x'] }, 'generateServerCard _meta'],
    [
      'a _meta key without a namespace',
      { ...required, _meta: { tier: 'free' } },
      'generateServerCard _meta key tier',
    ],
    ...[
      'modelcontextprotocol.io/x',
      'mcp.dev/x',
      'api.modelcontextprotocol.org/x',
      'tools.mcp.com/x',
    ].map((key): [string, unknown, string] => [
      `the reserved _meta key ${key}`,
      { ...required, _meta: { [key]: 1 } },
      `generateServerCard _meta key ${key}`,
    ]),
    [
      'a _meta key with a bad label',
      { ...required, _meta: { 'com.-example/x': 1 } },
      'generateServerCard _meta key com.-example/x',
    ],
    [
      'a _meta key with a bad name',
      { ...required, _meta: { 'com.example/-x': 1 } },
      'generateServerCard _meta key com.example/-x',
    ],
    ...(
      [
        ['a function', () => 1],
        ['undefined', undefined],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['a bigint', BigInt(1)],
        ['a symbol', Symbol('x')],
        ['a Date', new Date(0)],
        ['a nested undefined', { a: [undefined] }],
      ] as const
    ).map(([what, value]): [string, unknown, string] => [
      `_meta holding ${what}`,
      { ...required, _meta: { 'com.example/x': value } },
      'generateServerCard _meta com.example/x',
    ]),
  ])('rejects %s', (_name, options, message) => {
    expect(() => generateServerCard(options as never)).toThrow(`Clerk error: ${message}`);
  });

  test('rejects a _meta value that refers to itself', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() =>
      generateServerCard({ ...required, _meta: { 'com.example/x': value } } as never),
    ).toThrow('Clerk error: generateServerCard _meta com.example/x');
  });

  test.each(['1.0.0-beta.x', '1.0.0+build.x', 'release 2026'])(
    'accepts a non-range version string: %s',
    (version) => {
      expect(generateServerCard({ ...required, version }).version).toBe(version);
    },
  );

  test('accepts an http resourceUrl for local development, a data: icon, an empty _meta name, and options left undefined', () => {
    const card = generateServerCard({
      ...required,
      resourceUrl: 'http://localhost:3000/mcp',
      icons: [{ src: 'data:image/png;base64,iVBORw0KGgo=' }],
      _meta: { 'com.example/': 'x' },
      title: undefined,
      repository: undefined,
    });

    expect(card.remotes).toEqual([{ type: 'streamable-http', url: 'http://localhost:3000/mcp' }]);
    expect(card).not.toHaveProperty('title');
    expect(validateServerCard(card), JSON.stringify(validateServerCard.errors)).toBe(true);
  });

  test('is frozen all the way down, and later changes to the options do not reach it', () => {
    const meta = { 'com.example/tier': { plan: 'free' } };
    const icons = [{ src: 'https://example.com/icon.png' }];
    const card = generateServerCard({ ...required, icons, _meta: meta });

    meta['com.example/tier'].plan = 'paid';
    icons[0]!.src = 'https://evil.example/icon.png';

    expect(card._meta).toEqual({ 'com.example/tier': { plan: 'free' } });
    expect(card.icons).toEqual([{ src: 'https://example.com/icon.png' }]);
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.remotes[0])).toBe(true);
    expect(Object.isFrozen(card._meta?.['com.example/tier'])).toBe(true);
  });
});
