import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, test } from 'vitest';
import { generateServerCard } from './server';

// The Server Card JSON Schema, verbatim from
// https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/schema.json.
// Its canonical $schema URL is not served, so validation never fetches it. The bundle root holds only $defs and so
// accepts anything: a card is validated against #/$defs/ServerCard, as the upstream examples script does.
const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, 'test/fixtures/server-card.schema.json'), 'utf8'),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(schema, 'schema.json');
const validateServerCard = ajv.getSchema('schema.json#/$defs/ServerCard')!;

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
    expect(validateServerCard(card), JSON.stringify(validateServerCard.errors)).toBe(true);
    expect(validateServerCard(generateServerCard(required))).toBe(true);
  });

  // Controls on constraints the schema itself enforces, so a validator that accepted everything would fail them
  test.each([
    ['a missing $schema', ({ $schema: _, ...card }: Record<string, unknown>) => card],
    [
      'a dated $schema',
      (card: Record<string, unknown>) => ({
        ...card,
        $schema:
          'https://static.modelcontextprotocol.io/schemas/2025-01-01/server-card.schema.json',
      }),
    ],
    ['a name without a slash', (card: Record<string, unknown>) => ({ ...card, name: 'weather' })],
    ['a missing name', ({ name: _, ...card }: Record<string, unknown>) => card],
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
    ...['^1.2.3', '~1.2.3', '>=1.2.3', '1.x', '1.*', 'x', '1.2.3 - 2.0.0', '1 || 2'].map(
      (version): [string, unknown, string] => [
        `the version range ${version}`,
        { ...required, version },
        'generateServerCard version',
      ],
    ),
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
