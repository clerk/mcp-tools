import { describe, expect, test } from 'vitest';

import { generateRegistryServerJson, generateServerCard } from './server';
import { validateRegistryServerJson } from './test/registry-server-schema';

const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

const required = {
  name: 'com.example/weather',
  version: '1.2.0',
  description: 'Forecasts and current conditions.',
  resourceUrl: 'https://mcp.example.com/mcp',
};

// Every option the registry entry carries, set
const full = {
  ...required,
  title: 'Weather',
  websiteUrl: 'https://example.com/docs/weather',
  icons: [
    {
      src: 'https://example.com/icon.svg',
      mimeType: 'image/svg+xml',
      sizes: ['any'],
      theme: 'dark',
    },
    { src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48', '96x96'] },
  ],
  repository: {
    url: 'https://github.com/example/weather',
    source: 'github',
    subfolder: 'packages/server',
    id: '123456',
  },
} as const;

const serialized = (value: unknown) => JSON.parse(JSON.stringify(value));

function expectValid(value: unknown) {
  const valid = validateRegistryServerJson(serialized(value));
  expect(valid, JSON.stringify(validateRegistryServerJson.errors)).toBe(true);
}

describe('generateRegistryServerJson', () => {
  test('generates a schema-valid server.json with one streamable HTTP remote', () => {
    const serverJson = generateRegistryServerJson(required);

    expect(serverJson).toEqual({
      $schema: SCHEMA_URL,
      name: 'com.example/weather',
      version: '1.2.0',
      description: 'Forecasts and current conditions.',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    });
    expectValid(serverJson);
  });

  test('carries every card field the registry takes, and validates', () => {
    const serverJson = generateRegistryServerJson(full);

    expect(serverJson).toEqual({
      $schema: SCHEMA_URL,
      name: 'com.example/weather',
      version: '1.2.0',
      title: 'Weather',
      description: 'Forecasts and current conditions.',
      websiteUrl: 'https://example.com/docs/weather',
      repository: {
        url: 'https://github.com/example/weather',
        source: 'github',
        subfolder: 'packages/server',
        id: '123456',
      },
      icons: [
        {
          src: 'https://example.com/icon.svg',
          mimeType: 'image/svg+xml',
          sizes: ['any'],
          theme: 'dark',
        },
        { src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['48x48', '96x96'] },
      ],
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    });
    expectValid(serverJson);
  });

  test('describes the server exactly as the card from the same options does', () => {
    const { $schema: _cardSchema, ...card } = generateServerCard(full);
    const { $schema: _entrySchema, ...entry } = generateRegistryServerJson(full);

    expect(entry).toEqual(card);
  });

  test('lists one remote for each resourceUrl, in order', () => {
    const serverJson = generateRegistryServerJson({
      ...required,
      resourceUrl: ['https://mcp.example.com/mcp', 'https://mcp.example.dev/mcp'],
    });

    expect(serverJson.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      { type: 'streamable-http', url: 'https://mcp.example.dev/mcp' },
    ]);
    expectValid(serverJson);
  });

  test("leaves out the card's _meta, which the registry would drop", () => {
    const serverJson = generateRegistryServerJson({
      ...required,
      _meta: { 'com.example/tier': 'free' },
    });

    expect(serverJson).not.toHaveProperty('_meta');
  });

  test('is frozen and shares nothing with the options', () => {
    const icons = [{ src: 'https://example.com/icon.png' }];
    const serverJson = generateRegistryServerJson({ ...required, icons });
    icons[0]!.src = 'https://changed.example.com/icon.png';

    expect(serverJson.icons).toEqual([{ src: 'https://example.com/icon.png' }]);
    expect(Object.isFrozen(serverJson)).toBe(true);
    expect(Object.isFrozen(serverJson.remotes[0])).toBe(true);
  });

  // Controls on constraints the schema itself enforces, so a validator that accepted everything would fail them
  test.each([
    ['a description over 100 characters', { description: 'x'.repeat(101) }],
    ['a name without a slash', { name: 'weather' }],
    [
      'an icon media type the registry does not list',
      { icons: [{ src: 'https://example.com/i.gif', mimeType: 'image/gif' }] },
    ],
    [
      'an icon size that is not WxH',
      { icons: [{ src: 'https://example.com/i.png', sizes: ['large'] }] },
    ],
  ])('the pinned schema rejects %s', (_label, change) => {
    expect(
      validateRegistryServerJson(
        serialized({ ...generateRegistryServerJson(required), ...change }),
      ),
    ).toBe(false);
  });
});

describe('generateRegistryServerJson options', () => {
  test.each([
    ['an empty description', { description: '' }, 'description must be 1 to 100 characters'],
    [
      'a description over 100 characters',
      { description: 'x'.repeat(101) },
      'description must be 1 to 100 characters',
    ],
    [
      'a version range',
      { version: '^1.2.0' },
      'version must be 1 to 255 characters naming one version',
    ],
    [
      'an x-range version',
      { version: '1.x' },
      'version must be 1 to 255 characters naming one version',
    ],
    ['the reserved version latest', { version: 'latest' }, "version cannot be 'latest'"],
    // The registry's own range check, looksLikeVersionRange in internal/validators/validators.go
    [
      'a hyphen range with one space',
      { version: '1.0.0 -2.0.0' },
      'version must be one the registry does not read as a range',
    ],
    [
      'a prerelease the registry reads as a wildcard',
      { version: '1.0.0-next' },
      'version must be one the registry does not read as a range',
    ],
    [
      'an http icon',
      { icons: [{ src: 'http://example.com/icon.png' }] },
      'icons must each have an https src',
    ],
    [
      'a data: icon',
      { icons: [{ src: 'data:image/png;base64,iVBORw0KGgo=' }] },
      'icons must each have an https src',
    ],
    [
      'an icon src over 255 characters',
      { icons: [{ src: `https://example.com/${'a'.repeat(240)}.png` }] },
      'icons must each have an https src of at most 255 characters',
    ],
    [
      'an icon media type the registry does not list',
      { icons: [{ src: 'https://example.com/icon.gif', mimeType: 'image/gif' }] },
      'icons mimeType must be',
    ],
    [
      'an icon size that is not WxH',
      { icons: [{ src: 'https://example.com/icon.png', sizes: ['large'] }] },
      'icons sizes must each be WxH',
    ],
    ['an http website', { websiteUrl: 'http://example.com' }, 'websiteUrl must be an https URL'],
    ['a whitespace title', { title: '   ' }, 'title cannot be only whitespace'],
    [
      'a repository on another forge',
      { repository: { url: 'https://bitbucket.org/example/weather', source: 'bitbucket' } },
      'repository must be on GitHub or GitLab',
    ],
    [
      'a GitHub source with a non-GitHub url',
      { repository: { url: 'https://example.com/weather', source: 'github' } },
      'repository must be on GitHub or GitLab',
    ],
    [
      'an http remote',
      { resourceUrl: 'http://mcp.example.com/mcp' },
      'resourceUrl must be https and not on localhost',
    ],
    [
      'a localhost remote',
      { resourceUrl: 'https://localhost:3000/mcp' },
      'resourceUrl must be https and not on localhost',
    ],
    [
      'one http remote in a list',
      { resourceUrl: ['https://mcp.example.com/mcp', 'http://mcp.example.dev/mcp'] },
      'resourceUrl must be https and not on localhost',
    ],
    [
      'an empty resourceUrl list',
      { resourceUrl: [] },
      'resourceUrl must be a URL or a non-empty list of URLs',
    ],
    ['an unknown option', { packages: [] }, 'does not take packages'],
    ['a remotes option', { remotes: [] }, 'cannot set remotes'],
  ])('rejects %s', (_label, change, message) => {
    expect(() => generateRegistryServerJson({ ...required, ...change } as never)).toThrow(
      `Clerk error: generateRegistryServerJson ${message}`,
    );
  });

  test('rejects options that are not an object', () => {
    expect(() => generateRegistryServerJson(undefined as never)).toThrow(
      'Clerk error: generateRegistryServerJson takes the Server Card options',
    );
  });

  test('accepts a prerelease version the registry reads as one version', () => {
    expectValid(generateRegistryServerJson({ ...required, version: '1.0.0-beta.1' }));
  });

  test('accepts a GitLab repository in a subgroup', () => {
    const serverJson = generateRegistryServerJson({
      ...required,
      repository: { url: 'https://gitlab.com/group/subgroup/weather', source: 'gitlab' },
    });

    expectValid(serverJson);
  });
});
