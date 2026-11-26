import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

// The MCP Registry server.json JSON Schema from https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json,
// the URL its $id names, the same JSON as fetched, reformatted by oxfmt. It is draft-07,
// and its root refers to #/definitions/ServerDetail, so the root itself validates a server.json.
const schema = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/registry-server-2025-12-11.schema.json'),
    'utf8',
  ),
);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats.default(ajv);

/**
 * Validates a serialized server.json against the pinned 2025-12-11 registry schema.
 */
export const validateRegistryServerJson = ajv.compile(schema);
