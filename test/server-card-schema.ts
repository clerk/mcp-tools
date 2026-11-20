import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// The Server Card JSON Schema, verbatim from
// https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/schema.json.
// Its canonical $schema URL is not served, so validation never fetches it. The bundle root holds only $defs and so
// accepts anything: a card is validated against #/$defs/ServerCard, as the upstream examples script does.
const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/server-card.schema.json'), 'utf8'),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(schema, 'schema.json');

/**
 * Validates a serialized card against the pinned ServerCard definition, not the permissive bundle root.
 */
export const validateServerCard = ajv.getSchema('schema.json#/$defs/ServerCard')!;
