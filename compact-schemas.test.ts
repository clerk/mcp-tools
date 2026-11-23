// Compaction leaves what a tool schema accepts unchanged: a client validating tool inputs and outputs against the
// listed schemas, as the MCP SDK clients do with Ajv, accepts and rejects the same values either way.
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';

import { compactJsonSchema } from './server';

type Case = {
  name: string;
  schema: Record<string, unknown>;
  accepts: unknown[];
  rejects: unknown[];
  compacted: Record<string, unknown>;
};

const CASES: Case[] = [
  {
    name: 'a record of anything, in 2020-12',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        labels: {
          type: 'object',
          propertyNames: { pattern: '^[a-z]+$' },
          additionalProperties: {},
        },
      },
      required: ['labels'],
    },
    accepts: [{ labels: {} }, { labels: { a: 1, b: 'x' } }, { labels: {}, extra: true }],
    rejects: [{}, { labels: { A: 1 } }, { labels: 'x' }],
    compacted: {
      type: 'object',
      properties: { labels: { type: 'object', propertyNames: { pattern: '^[a-z]+$' } } },
      required: ['labels'],
    },
  },
  {
    name: 'a property named additionalProperties and a closed object',
    schema: {
      type: 'object',
      properties: {
        additionalProperties: { type: 'object', properties: {}, additionalProperties: false },
      },
      additionalProperties: false,
    },
    accepts: [{}, { additionalProperties: {} }],
    rejects: [{ other: 1 }, { additionalProperties: { a: 1 } }],
    compacted: {
      type: 'object',
      properties: {
        additionalProperties: { type: 'object', properties: {}, additionalProperties: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'empty additionalProperties under anyOf, items, and $defs',
    schema: {
      $defs: { open: { type: 'object', additionalProperties: {} } },
      type: 'array',
      items: {
        anyOf: [
          { $ref: '#/$defs/open' },
          { type: 'object', additionalProperties: {}, required: ['id'] },
        ],
      },
      default: [{ additionalProperties: {} }],
    },
    accepts: [[], [{}], [{ id: 1, more: 2 }]],
    rejects: [[1], 'x'],
    compacted: {
      $defs: { open: { type: 'object' } },
      type: 'array',
      items: { anyOf: [{ $ref: '#/$defs/open' }, { type: 'object', required: ['id'] }] },
      default: [{ additionalProperties: {} }],
    },
  },
  {
    // An empty `additionalProperties` evaluates every property, which `unevaluatedProperties` reads
    name: 'empty additionalProperties that unevaluatedProperties depends on',
    schema: {
      type: 'object',
      properties: { a: { type: 'number' } },
      allOf: [{ additionalProperties: {} }],
      unevaluatedProperties: false,
    },
    accepts: [{}, { a: 1 }, { a: 1, b: 2 }],
    rejects: [{ a: 'x' }],
    compacted: {
      type: 'object',
      properties: { a: { type: 'number' } },
      allOf: [{ additionalProperties: {} }],
      unevaluatedProperties: false,
    },
  },
];

// The draft-07 `$schema` MCP SDK 1.x writes is kept: without it MCP reads the schema as 2020-12
const DRAFT_07_CASE = {
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { tags: { type: 'array', items: [{ type: 'string' }], additionalItems: false } },
    additionalProperties: {},
  },
  accepts: [{}, { tags: [] }, { tags: ['a'] }],
  rejects: [{ tags: [1] }, { tags: ['a', 'b'] }],
  compacted: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { tags: { type: 'array', items: [{ type: 'string' }], additionalItems: false } },
  },
};

function verdicts(validate: (value: unknown) => boolean, values: unknown[]) {
  return values.map((value) => validate(value));
}

describe('compactJsonSchema', () => {
  test.each(CASES)('compacts $name', ({ schema, compacted }) => {
    expect(compactJsonSchema(schema)).toEqual(compacted);
  });

  test.each(CASES)(
    'accepts and rejects the same values for $name, as 2020-12',
    ({ schema, accepts, rejects }) => {
      const ajv = new Ajv2020({ strict: false });
      const values = [...accepts, ...rejects];
      const expected = [...accepts.map(() => true), ...rejects.map(() => false)];
      expect(verdicts(ajv.compile(schema), values)).toEqual(expected);
      expect(verdicts(ajv.compile(compactJsonSchema(schema)), values)).toEqual(expected);
    },
  );

  test('keeps a draft-07 $schema and validates the same as draft-07', () => {
    const { schema, accepts, rejects, compacted } = DRAFT_07_CASE;
    expect(compactJsonSchema(schema)).toEqual(compacted);
    const ajv = new Ajv({ strict: false });
    const values = [...accepts, ...rejects];
    const expected = [...accepts.map(() => true), ...rejects.map(() => false)];
    expect(verdicts(ajv.compile(schema), values)).toEqual(expected);
    expect(verdicts(ajv.compile(compactJsonSchema(schema)), values)).toEqual(expected);
  });

  // Draft-07 `dependencies`: a schema value is a subschema and is compacted, a list of property names is kept
  test('compacts the schema values of draft-07 dependencies and validates the same', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        card: { type: 'string' },
        billing: { type: 'string' },
        name: { type: 'string' },
      },
      dependencies: {
        card: {
          properties: {
            billing: { type: 'string' },
            meta: { type: 'object', additionalProperties: {} },
          },
          required: ['billing'],
          additionalProperties: {},
        },
        name: ['card'],
      },
    };
    expect(compactJsonSchema(schema)).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        card: { type: 'string' },
        billing: { type: 'string' },
        name: { type: 'string' },
      },
      dependencies: {
        card: {
          properties: { billing: { type: 'string' }, meta: { type: 'object' } },
          required: ['billing'],
        },
        name: ['card'],
      },
    });
    const ajv = new Ajv({ strict: false });
    const values = [
      {},
      { card: 'x', billing: 'y' },
      { card: 'x', billing: 'y', meta: { any: 1 }, extra: true },
      { name: 'n', card: 'x', billing: 'y' },
      { card: 'x' },
      { card: 'x', billing: 1 },
      { name: 'n' },
      { card: 'x', billing: 'y', meta: 'not an object' },
    ];
    const expected = [true, true, true, true, false, false, false, false];
    expect(verdicts(ajv.compile(schema), values)).toEqual(expected);
    expect(verdicts(ajv.compile(compactJsonSchema(schema)), values)).toEqual(expected);
  });

  // The control for the case above: dropping that empty `additionalProperties` would reject `{ a: 1, b: 2 }`
  test('an empty additionalProperties changes what unevaluatedProperties accepts', () => {
    const ajv = new Ajv2020({ strict: false });
    const dropped = ajv.compile({
      type: 'object',
      properties: { a: { type: 'number' } },
      allOf: [{}],
      unevaluatedProperties: false,
    });
    expect(dropped({ a: 1, b: 2 })).toBe(false);
  });

  test('does not modify the schema it is given', () => {
    const schema = structuredClone(CASES[0]!.schema);
    compactJsonSchema(schema);
    expect(schema).toEqual(CASES[0]!.schema);
  });
});
