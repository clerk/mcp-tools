import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  fetchAuthorizationServerMetadata,
  generateProtectedResourceMetadata,
  isClerkAuthInfo,
  matchResourceUrl,
  toClerkAuthInfo,
} from './server';
import { clerkAuthenticated, FAKE_PK } from './test/mcp-harness';

// RFC 9728 section 2 parameters only: `jwks_uri` would name the protected resource's own keys, not the
// authorization server's, and `resource_documentation` must describe the app's own server, which only it can name.
describe('generateProtectedResourceMetadata', () => {
  // A publishable key names its Frontend API as the authorization server
  test.each([
    [{ authServerUrl: 'https://auth.example.com' }, 'https://auth.example.com'],
    [{ publishableKey: FAKE_PK }, 'https://clerk.example.com'],
  ])('holds only the RFC 9728 parameters it can state, given %j', (keyOptions, authServer) => {
    expect(
      generateProtectedResourceMetadata({
        ...keyOptions,
        resourceUrl: 'https://mcp.example.com/mcp',
      }),
    ).toStrictEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: [authServer],
      bearer_methods_supported: ['header'],
    });
  });

  test('adds and overrides with properties', () => {
    expect(
      generateProtectedResourceMetadata({
        authServerUrl: 'https://auth.example.com',
        resourceUrl: 'https://mcp.example.com/mcp',
        properties: { resource_name: 'Example MCP', bearer_methods_supported: [] },
      }),
    ).toStrictEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: [],
      resource_name: 'Example MCP',
    });
  });

  // RFC 9728 section 3.3: a client discards metadata whose `resource` is not the URL it derived the metadata URL
  // from, so `resource` is always `resourceUrl`. An own `resource: undefined`, as from spreading a partial config,
  // would otherwise clear it.
  test.each([
    ['another URL', { resource: 'https://mcp.example.com' }],
    ['undefined', { resource: undefined }],
  ])('throws a Clerk error when properties sets resource to %s', (_name, properties) => {
    for (const keyOptions of [
      { authServerUrl: 'https://auth.example.com' },
      { publishableKey: FAKE_PK },
    ]) {
      expect(() =>
        generateProtectedResourceMetadata({
          ...keyOptions,
          resourceUrl: 'https://mcp.example.com/mcp',
          properties,
        }),
      ).toThrow(
        'Clerk error: generateProtectedResourceMetadata properties cannot set resource: it must be the resourceUrl the metadata describes (RFC 9728 section 3.3)',
      );
    }
  });
});

describe('generateProtectedResourceMetadata with a publishable key', () => {
  test.each(['pk_test_abc', `pk_test_${btoa('$')}`, `sk_test_${btoa('clerk.example.com$')}`, ''])(
    'throws a Clerk error for the publishable key %j',
    (key) => {
      expect(() =>
        generateProtectedResourceMetadata({
          publishableKey: key,
          resourceUrl: 'https://mcp.example.com/mcp',
        }),
      ).toThrow('Clerk error: the publishable key is not a Clerk publishable key');
    },
  );
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

describe('fetchAuthorizationServerMetadata', () => {
  const publishableKey = FAKE_PK;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns the Frontend API's metadata", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ issuer: 'https://clerk.example.com' }));

    await expect(fetchAuthorizationServerMetadata({ publishableKey })).resolves.toStrictEqual({
      issuer: 'https://clerk.example.com',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://clerk.example.com/.well-known/oauth-authorization-server',
      { signal: expect.any(AbortSignal) },
    );
  });

  test('gives up on a Frontend API that does not answer, with a Clerk error', async () => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() =>
        AbortSignal.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
      );
    // A Frontend API that accepts the request and never answers: only the signal ends it
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );

    const error = await fetchAuthorizationServerMetadata({ publishableKey }).catch(
      (thrown: unknown) => thrown,
    );

    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message:
        'Clerk error: fetching authorization server metadata from https://clerk.example.com timed out after 5 seconds',
      cause: { name: 'TimeoutError' },
    });
  });

  test('passes on a network error other than the timeout as it is', async () => {
    const cause = new TypeError('fetch failed');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause);

    await expect(fetchAuthorizationServerMetadata({ publishableKey })).rejects.toBe(cause);
  });

  test('throws instead of returning an error body as the metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ errors: [{ code: 'resource_not_found' }] }, { status: 404 }),
    );

    await expect(fetchAuthorizationServerMetadata({ publishableKey })).rejects.toThrow(
      'Clerk error: fetching authorization server metadata from https://clerk.example.com failed with status 404',
    );
  });
});

describe('toClerkAuthInfo', () => {
  test('trusts its own result, but not a forged marker or an external copy', () => {
    const authInfo = toClerkAuthInfo(clerkAuthenticated().toAuth(), 'token');

    expect(isClerkAuthInfo(authInfo)).toBe(true);
    expect(isClerkAuthInfo({ ...authInfo! })).toBe(false);
    expect(
      isClerkAuthInfo({
        token: 'token',
        clientId: '',
        scopes: [],
        extra: { userId: 'user-1', verifiedBy: 'clerk' },
      }),
    ).toBe(false);
    expect(isClerkAuthInfo(undefined)).toBe(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A request without a valid token is an ordinary outcome, such as `auth()` in a route a signed-out client called,
  // not an error to log on every such request
  test('returns undefined for an unauthenticated auth object without logging', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      toClerkAuthInfo({ isAuthenticated: false, tokenType: 'oauth_token' }, 'token'),
    ).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
