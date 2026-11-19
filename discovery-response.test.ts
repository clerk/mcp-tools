import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { aiCatalogResponder } from './discovery-response';

describe('discovery response entity-tag parsing', () => {
  test('bounds matching a malformed If-None-Match list with long whitespace', () => {
    const respond = aiCatalogResponder('aiCatalogHandler', { entries: [] });
    const ifNoneMatch = `"a",${'\t'.repeat(16_384)}x`;
    const start = performance.now();
    const answer = respond({
      method: 'GET',
      url: 'https://mcp.example.com/mcp',
      ifMatch: null,
      ifNoneMatch,
    });
    const elapsedMs = performance.now() - start;

    expect(answer.status).toBe(200);
    expect(elapsedMs).toBeLessThan(50);
  });
});
