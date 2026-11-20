import { beforeEach, describe, expect, test, vi } from 'vitest';

const pgClient = vi.hoisted(() => ({
  queries: [] as { text: string; values?: unknown[] }[],
  respond: (_text: string, _values?: unknown[]): unknown => ({ rows: [], rowCount: 0 }),
}));

vi.mock('pg', () => ({
  default: {
    Client: class {
      on() {}
      async connect() {}
      async end() {}
      async query(text: string, values?: unknown[]) {
        pgClient.queries.push({ text, values });
        return pgClient.respond(text, values);
      }
    },
  },
}));

const { createPostgresStore } = await import('./postgres');

/** The queries sent so far, with whitespace collapsed. */
function sent() {
  return pgClient.queries.map(({ text }) => text.replace(/\s+/g, ' ').trim());
}

beforeEach(() => {
  pgClient.queries = [];
  pgClient.respond = () => ({ rows: [], rowCount: 0 });
});

describe('createPostgresStore', () => {
  test('creates the table under a lock for its name, in a transaction', async () => {
    const store = createPostgresStore({ tableName: 'mcp_sessions' });
    await store.exists('key');

    const queries = sent();
    expect(queries.slice(0, 2)).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock(hashtext($1))']);
    expect(pgClient.queries[1].values).toEqual(['mcp_sessions']);
    expect(queries[2]).toMatch(/^CREATE TABLE IF NOT EXISTS mcp_sessions /);
    expect(queries[3]).toMatch(/^CREATE INDEX IF NOT EXISTS idx_mcp_sessions_created_at /);
    expect(queries[4]).toBe('COMMIT');
  });

  test('rolls back and rejects each operation when creating the table fails', async () => {
    pgClient.respond = (text) => {
      if (text.includes('CREATE TABLE')) throw new Error('permission denied for schema public');
      return { rows: [], rowCount: 0 };
    };
    const store = createPostgresStore();

    await expect(store.read('key')).rejects.toThrow('permission denied for schema public');
    expect(sent()).toContain('ROLLBACK');
    expect(sent()).not.toContain('COMMIT');
  });

  test('read selects the JSON text of the value', async () => {
    const store = createPostgresStore();
    await store.read('key');

    expect(sent().at(-1)).toBe('SELECT value::text AS value FROM mcp_store WHERE key = $1');
    expect(pgClient.queries.at(-1)!.values).toEqual(['key']);
  });

  test.each([
    ['a string', 'session-id', '"session-id"'],
    ['a string of digits', '123', '"123"'],
    ['a string that reads as a boolean', 'true', '"true"'],
    ['a string holding JSON', '{"a":1}', '"{\\"a\\":1}"'],
    ['a number', 123, '123'],
    ['a boolean', true, 'true'],
    ['null', null, 'null'],
    [
      'an object',
      { clientId: 'abc', nested: [1, 'two'] },
      '{"nested": [1, "two"], "clientId": "abc"}',
    ],
  ])('read returns %s as written', async (_name, written, stored) => {
    pgClient.respond = (text) =>
      text.startsWith('SELECT value::text')
        ? { rows: [{ value: stored }] }
        : { rows: [], rowCount: 0 };
    const store = createPostgresStore();

    expect(await store.read('key')).toEqual(written);
  });

  test('write stores the JSON text of the value', async () => {
    const store = createPostgresStore();
    await store.write('key', 'session-id');

    expect(pgClient.queries.at(-1)!.values).toEqual(['key', '"session-id"']);
  });

  test('read resolves null for a missing key', async () => {
    const store = createPostgresStore();

    expect(await store.read('missing')).toBeNull();
  });

  test('read rejects a value that is not JSON text', async () => {
    pgClient.respond = (text) =>
      text.startsWith('SELECT value::text')
        ? { rows: [{ value: 'not json' }] }
        : { rows: [], rowCount: 0 };
    const store = createPostgresStore();

    await expect(store.read('key')).rejects.toThrow(
      'Failed to parse stored value for key "key": Invalid JSON',
    );
  });
});
