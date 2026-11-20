import { describe, expect, test } from 'vitest';
import { aiCatalogResponder } from './discovery-response';

describe('discovery response entity-tag parsing', () => {
  test.each([16, 16_384])('rejects a malformed If-None-Match list with %i tabs', (length) => {
    const respond = aiCatalogResponder('aiCatalogHandler', { entries: [] });
    const ifNoneMatch = `"a",${'\t'.repeat(length)}x`;
    const answer = respond({
      method: 'GET',
      url: 'https://mcp.example.com/mcp',
      ifMatch: null,
      ifNoneMatch,
    });

    expect(answer.status).toBe(200);
  });
});
