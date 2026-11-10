import { describe, expect, test } from 'vitest';
import { matchResourceUrl } from './server';

describe('matchResourceUrl', () => {
  const urls = ['https://mcp.example.com/mcp', 'https://mcp.example.dev/mcp'];

  test('returns a single URL whatever the request origin', () => {
    expect(matchResourceUrl('https://mcp.example.com/mcp', 'http://internal:3000/mcp')).toBe(
      'https://mcp.example.com/mcp',
    );
  });

  test('picks the listed URL with the request origin, for any path on it', () => {
    expect(matchResourceUrl(urls, 'https://mcp.example.dev/mcp?x=1')).toBe(urls[1]);
    expect(
      matchResourceUrl(
        urls,
        new URL('https://mcp.example.com/.well-known/oauth-protected-resource/mcp'),
      ),
    ).toBe(urls[0]);
  });

  test('returns undefined for an origin no listed URL has', () => {
    expect(matchResourceUrl(urls, 'https://evil.example.com/mcp')).toBeUndefined();
    expect(matchResourceUrl(urls, 'http://mcp.example.com/mcp')).toBeUndefined();
    expect(matchResourceUrl(['not a url'], 'https://mcp.example.com/mcp')).toBeUndefined();
  });
});
