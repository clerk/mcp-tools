import { describe, expect, test } from 'vitest';
import {
  generateClerkProtectedResourceMetadata,
  generateProtectedResourceMetadata,
  matchResourceUrl,
} from './server';

// RFC 9728 section 2 parameters only: `jwks_uri` would name the protected resource's own keys, not the
// authorization server's, and Clerk's documentation link is `resource_documentation`.
describe('generateProtectedResourceMetadata', () => {
  test('holds only the RFC 9728 parameters it can state', () => {
    expect(
      generateProtectedResourceMetadata({
        authServerUrl: 'https://auth.example.com',
        resourceUrl: 'https://mcp.example.com/mcp',
      }),
    ).toStrictEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
    });
  });

  test('adds and overrides with properties', () => {
    expect(
      generateProtectedResourceMetadata({
        authServerUrl: 'https://auth.example.com',
        resourceUrl: 'https://mcp.example.com/mcp',
        properties: { resource_name: 'Example MCP', resource: 'https://mcp.example.com' },
      }),
    ).toStrictEqual({
      resource: 'https://mcp.example.com',
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
      resource_name: 'Example MCP',
    });
  });
});

describe('generateClerkProtectedResourceMetadata', () => {
  test('names the Frontend API as the authorization server and links the docs', () => {
    const publishableKey = `pk_test_${btoa('clerk.example.com$')}`;
    expect(
      generateClerkProtectedResourceMetadata({
        publishableKey,
        resourceUrl: 'https://mcp.example.com/mcp',
      }),
    ).toStrictEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://clerk.example.com'],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://clerk.com/docs',
    });
  });
});

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
