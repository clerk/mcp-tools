import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  completeOAuth,
  createDynamicallyRegisteredMcpClient,
  createKnownCredentialsMcpClient,
  getMcpClientBySessionId,
  type JsonSerializable,
  type McpClientStore,
} from './client';

const clientParams = {
  oauthRedirectUrl: 'https://client.example/callback',
  mcpEndpoint: 'https://resource.example/mcp',
  mcpClientName: 'test-client',
  mcpClientVersion: '1.0.0',
};
const issuer = 'https://auth.example/';
const clientInformation: OAuthClientInformationMixed = {
  client_id: 'client-id',
  client_secret: 'client-secret',
  redirect_uris: [clientParams.oauthRedirectUrl],
  token_endpoint_auth_method: 'client_secret_post',
  issuer,
};
const tokens: OAuthTokens = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'read',
  issuer,
};

function createStore(): McpClientStore {
  const data = new Map<string, string>();
  return {
    write: async (key, value) => {
      data.set(key, JSON.stringify(value));
    },
    read: async (key) => {
      const value = data.get(key);
      return value ? (JSON.parse(value) as JsonSerializable) : undefined;
    },
  };
}

function discoveryState(authorizationServerUrl = issuer) {
  return {
    authorizationServerUrl,
    resourceMetadata: {
      resource: clientParams.mcpEndpoint,
      authorization_servers: [authorizationServerUrl],
    },
    authorizationServerMetadata: {
      issuer: authorizationServerUrl,
      authorization_endpoint: `${authorizationServerUrl}authorize`,
      token_endpoint: `${authorizationServerUrl}token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    },
  };
}

const resourceMetadataPath = '/.well-known/oauth-protected-resource';
const authorizationServerMetadataPath = '/.well-known/oauth-authorization-server';

/**
 * Serves the resource and authorization server metadata, registration and
 * token endpoints, naming `authorizationServer.url` as the resource's
 * authorization server. Change `url` to move the resource to another one.
 */
function authorizationServerFetch(url: string) {
  const authorizationServer = { url };
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input);
    const origin = `${requestUrl.origin}/`;
    if (requestUrl.pathname.startsWith(resourceMetadataPath)) {
      return Response.json({
        resource: clientParams.mcpEndpoint,
        authorization_servers: [authorizationServer.url],
      });
    }
    if (requestUrl.pathname === authorizationServerMetadataPath) {
      return Response.json({
        ...discoveryState(origin).authorizationServerMetadata,
        registration_endpoint: `${origin}register`,
      });
    }
    if (requestUrl.pathname === '/register' && init?.method === 'POST') {
      return Response.json({
        client_id: `registered-at-${requestUrl.host}`,
        client_secret: `registered-secret-${requestUrl.host}`,
        redirect_uris: [clientParams.oauthRedirectUrl],
      });
    }
    if (requestUrl.pathname === '/token' && init?.method === 'POST') {
      return Response.json({
        access_token: `access-from-${requestUrl.host}`,
        refresh_token: `refresh-from-${requestUrl.host}`,
        token_type: 'Bearer',
      });
    }
    return new Response(null, { status: 404 });
  });
  return { authorizationServer, fetchFn };
}

/** The error a resumed session gives for client credentials not bound to an issuer. */
function notBound(sessionId: string) {
  return `Session "${sessionId}" has OAuth client credentials that are not bound to an authorization server`;
}

/** The requests that carry credentials, as `METHOD url`. */
function credentialRequests(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetchFn.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([input]) => `POST ${String(input instanceof Request ? input.url : input)}`);
}

describe('OAuth credential persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each(['known', 'dynamic'] as const)(
    '%s client retains complete SDK credentials',
    async (kind) => {
      const store = createStore();
      const options = { ...clientParams, store, redirect: vi.fn() };
      const { sessionId, expected } = await (async () => {
        if (kind === 'dynamic') {
          const initial = await createDynamicallyRegisteredMcpClient(options);
          await initial.authProvider.saveClientInformation!(clientInformation);
          return { sessionId: initial.sessionId, expected: clientInformation };
        }
        // Known credentials are bound when authorization starts.
        const initial = await createKnownCredentialsMcpClient({
          ...options,
          clientId: 'client-id',
          clientSecret: 'client-secret',
        });
        const { fetchFn } = authorizationServerFetch(issuer);
        await expect(
          auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
        ).resolves.toBe('REDIRECT');
        return {
          sessionId: initial.sessionId,
          expected: { client_id: 'client-id', client_secret: 'client-secret', issuer },
        };
      })();

      const resumed = await getMcpClientBySessionId({ sessionId, store });
      expect(await resumed.authProvider.clientInformation()).toEqual(expected);
      await resumed.authProvider.saveTokens(tokens);
      expect(await resumed.authProvider.tokens()).toEqual(tokens);
      // Saving tokens must not erase the issuer saved immediately before them.
      expect(await resumed.authProvider.clientInformation()).toEqual(expected);

      const reloaded = await getMcpClientBySessionId({ sessionId, store });
      expect(await reloaded.authProvider.clientInformation()).toEqual(expected);
      expect(await reloaded.authProvider.tokens()).toEqual(tokens);
      expect(reloaded.clientData).toMatchObject({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
    },
  );

  test('dynamic initializer token saves retain registration and token metadata', async () => {
    const store = createStore();
    const initial = await createDynamicallyRegisteredMcpClient({
      ...clientParams,
      store,
      redirect: vi.fn(),
    });
    await initial.authProvider.saveClientInformation!(clientInformation);
    await initial.authProvider.saveTokens(tokens);
    const reloaded = await getMcpClientBySessionId({ sessionId: initial.sessionId, store });
    expect(await reloaded.authProvider.clientInformation()).toEqual(clientInformation);
    expect(await reloaded.authProvider.tokens()).toEqual(tokens);
  });

  test('legacy sessions present only their access token and sequential saves merge the latest session', async () => {
    const store = createStore();
    const legacy = {
      ...clientParams,
      clientId: 'legacy-client',
      clientSecret: 'legacy-secret',
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
    };
    await store.write('session_legacy', legacy);
    const resumed = await getMcpClientBySessionId({ sessionId: 'legacy', store });
    expect(resumed.authProvider.saveClientInformation).toBeUndefined();
    await expect(resumed.authProvider.clientInformation()).rejects.toThrow(notBound('legacy'));
    expect(await resumed.authProvider.tokens()).toEqual({
      access_token: 'legacy-access',
      token_type: 'Bearer',
    });

    await store.write('session_legacy', { ...legacy, authComplete: true });
    await resumed.authProvider.saveTokens(tokens);
    expect(await store.read('session_legacy')).toMatchObject({
      authComplete: true,
      oauthTokens: tokens,
    });
  });

  test('an unregistered session returns no client information', async () => {
    const store = createStore();
    await store.write('session_empty', clientParams);
    const resumed = await getMcpClientBySessionId({ sessionId: 'empty', store });
    expect(await resumed.authProvider.clientInformation()).toBeUndefined();
  });

  test('SDK code exchange uses known credentials bound at redirect', async () => {
    const store = createStore();
    const { fetchFn } = authorizationServerFetch('https://a.example/');
    let atRedirect: Promise<JsonSerializable | undefined> | undefined;
    const initial = await createKnownCredentialsMcpClient({
      ...clientParams,
      store,
      // Reads the session as the user is sent away, so a callback that
      // arrives before auth() returns still finds the binding.
      redirect: () => {
        atRedirect = store.read(`session_${initial.sessionId}`);
      },
      clientId: 'user-client',
      clientSecret: 'user-secret',
    });
    await expect(
      auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
    ).resolves.toBe('REDIRECT');
    // Bound before the user is sent to the authorization server, with nothing posted.
    expect(atRedirect).toBeDefined();
    expect(await atRedirect).toMatchObject({
      oauthClientInformation: {
        client_id: 'user-client',
        client_secret: 'user-secret',
        issuer: 'https://a.example/',
      },
    });
    expect(credentialRequests(fetchFn)).toEqual([]);

    const state = await initial.authProvider.state!();
    const resumed = await getMcpClientBySessionId({ sessionId: initial.sessionId, store, state });
    await expect(
      auth(resumed.authProvider, {
        serverUrl: clientParams.mcpEndpoint,
        authorizationCode: 'code',
        fetchFn,
      }),
    ).resolves.toBe('AUTHORIZED');
    expect(credentialRequests(fetchFn)).toEqual(['POST https://a.example/token']);
    const reloaded = await getMcpClientBySessionId({ sessionId: initial.sessionId, store });
    expect(await reloaded.authProvider.clientInformation()).toMatchObject({
      client_id: 'user-client',
      issuer: 'https://a.example/',
    });
    expect(await reloaded.authProvider.tokens()).toMatchObject({ issuer: 'https://a.example/' });
  });

  test.each(['known', 'dynamic'] as const)(
    'a %s callback uses the authorization server found at a resource metadata URL from the challenge',
    async (kind) => {
      const store = createStore();
      const resourceMetadataUrl = new URL('https://resource.example/prm/mcp');
      const { fetchFn: authorizationServers } = authorizationServerFetch('https://a.example/');
      // Only the challenge's URL serves resource metadata, so discovery without
      // it falls back to the MCP server's origin as the authorization server.
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        const requestUrl = new URL(input instanceof Request ? input.url : input);
        if (requestUrl.href === resourceMetadataUrl.href) {
          return Response.json({
            resource: clientParams.mcpEndpoint,
            authorization_servers: ['https://a.example/'],
          });
        }
        if (requestUrl.pathname.startsWith(resourceMetadataPath)) {
          return new Response(null, { status: 404 });
        }
        return authorizationServers(input, init);
      });
      const options = { ...clientParams, store, redirect: vi.fn() };
      const initial =
        kind === 'known'
          ? await createKnownCredentialsMcpClient({
              ...options,
              clientId: 'user-client',
              clientSecret: 'user-secret',
            })
          : await createDynamicallyRegisteredMcpClient(options);
      await expect(
        auth(initial.authProvider, {
          serverUrl: clientParams.mcpEndpoint,
          resourceMetadataUrl,
          fetchFn,
        }),
      ).resolves.toBe('REDIRECT');
      fetchFn.mockClear();

      const state = await initial.authProvider.state!();
      const resumed = await getMcpClientBySessionId({ sessionId: initial.sessionId, store, state });
      await expect(
        auth(resumed.authProvider, {
          serverUrl: clientParams.mcpEndpoint,
          authorizationCode: 'code',
          fetchFn,
        }),
      ).resolves.toBe('AUTHORIZED');
      expect(credentialRequests(fetchFn)).toEqual(['POST https://a.example/token']);
      const reloaded = await getMcpClientBySessionId({ sessionId: initial.sessionId, store });
      expect(await reloaded.authProvider.clientInformation()).toMatchObject({
        issuer: 'https://a.example/',
      });
      expect(await reloaded.authProvider.tokens()).toMatchObject({ issuer: 'https://a.example/' });
      expect(await store.read(`session_${initial.sessionId}`)).not.toHaveProperty(
        'oauthDiscoveryState',
      );
    },
  );

  test('a known initializer that fails before the redirect leaves its session unbound', async () => {
    const store = createStore();
    const { fetchFn: authorizationServers } = authorizationServerFetch('https://a.example/');
    // The authorization server does not support the code response type, so
    // the SDK rejects the authorization request before any redirect.
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const response = await authorizationServers(input, init);
      const requestUrl = new URL(input instanceof Request ? input.url : input);
      if (requestUrl.pathname !== authorizationServerMetadataPath) return response;
      return Response.json({ ...(await response.json()), response_types_supported: ['token'] });
    });
    const redirect = vi.fn();
    const initial = await createKnownCredentialsMcpClient({
      ...clientParams,
      store,
      redirect,
      clientId: 'user-client',
      clientSecret: 'user-secret',
    });
    const unbound = await store.read(`session_${initial.sessionId}`);
    await expect(
      auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
    ).rejects.toThrow('does not support response type code');
    expect(redirect).not.toHaveBeenCalled();
    expect(await store.read(`session_${initial.sessionId}`)).toEqual(unbound);
  });

  test('saves compare issuers as URLs, as the SDK does', async () => {
    const store = createStore();
    await store.write('session_bound', {
      ...clientParams,
      oauthClientInformation: { ...clientInformation, issuer: 'https://AUTH.example:443/' },
    });
    const resumed = await getMcpClientBySessionId({ sessionId: 'bound', store });
    await resumed.authProvider.saveTokens({ ...tokens, issuer: 'https://auth.example' });
    expect(await store.read('session_bound')).toMatchObject({
      oauthTokens: { issuer: 'https://auth.example' },
    });
    await expect(
      resumed.authProvider.saveTokens({ ...tokens, issuer: 'https://auth.example:8443/' }),
    ).rejects.toThrow(
      'is bound to authorization server https://AUTH.example:443/ and does not save tokens for https://auth.example:8443/',
    );
  });

  test('SDK rejects credentials bound to another issuer before exchanging a code', async () => {
    const store = createStore();
    await store.write('session_bound', {
      ...clientParams,
      oauthClientInformation: clientInformation,
    });
    const resumed = await getMcpClientBySessionId({ sessionId: 'bound', store });
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      auth(
        {
          ...resumed.authProvider,
          discoveryState: () => discoveryState('https://other-auth.example/'),
        },
        {
          serverUrl: clientParams.mcpEndpoint,
          authorizationCode: 'code',
          fetchFn,
        },
      ),
    ).rejects.toThrow(
      'OAuth client information is bound to authorization server https://auth.example/ and is not presented to https://other-auth.example/',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('SDK does not send a refresh token bound to another issuer', async () => {
    const store = createStore();
    await store.write('session_bound', {
      ...clientParams,
      oauthClientInformation: clientInformation,
      oauthTokens: { ...tokens, issuer: 'https://other-auth.example/' },
    });
    const resumed = await getMcpClientBySessionId({ sessionId: 'bound', store });
    const fetchFn = vi.fn<typeof fetch>();
    const redirectToAuthorization = vi.fn();
    await expect(
      auth(
        {
          ...resumed.authProvider,
          discoveryState,
          redirectToAuthorization,
          saveCodeVerifier: vi.fn(),
        },
        {
          serverUrl: clientParams.mcpEndpoint,
          fetchFn,
        },
      ),
    ).resolves.toBe('REDIRECT');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(redirectToAuthorization).toHaveBeenCalledOnce();
  });

  test.each(['known', 'dynamic'] as const)(
    'a %s session bound at one issuer does not register at another or replace its credentials',
    async (kind) => {
      const store = createStore();
      const { authorizationServer, fetchFn } = authorizationServerFetch('https://a.example/');
      const options = { ...clientParams, store, redirect: vi.fn() };
      const initial =
        kind === 'known'
          ? await createKnownCredentialsMcpClient({
              ...options,
              clientId: 'user-client',
              clientSecret: 'user-secret',
            })
          : await createDynamicallyRegisteredMcpClient(options);
      await expect(
        auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
      ).resolves.toBe('REDIRECT');

      const state = await initial.authProvider.state!();
      const resumed = await getMcpClientBySessionId({ sessionId: initial.sessionId, store, state });
      await expect(
        auth(resumed.authProvider, {
          serverUrl: clientParams.mcpEndpoint,
          authorizationCode: 'code',
          fetchFn,
        }),
      ).resolves.toBe('AUTHORIZED');
      const bound = await store.read(`session_${initial.sessionId}`);
      expect(bound).toMatchObject({ oauthClientInformation: { issuer: 'https://a.example/' } });

      // The same provider instance, and a reloaded one, now meet another issuer.
      authorizationServer.url = 'https://b.example/';
      fetchFn.mockClear();
      const reloaded = await getMcpClientBySessionId({ sessionId: initial.sessionId, store });
      for (const provider of [resumed.authProvider, reloaded.authProvider]) {
        await expect(
          auth(provider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
        ).rejects.toThrow(
          'OAuth client information is bound to authorization server https://a.example/ and is not presented to https://b.example/',
        );
      }
      expect(credentialRequests(fetchFn)).toEqual([]);
      expect(await store.read(`session_${initial.sessionId}`)).toEqual(bound);
    },
  );

  test('a pre-upgrade session that gets a 401 sends no refresh token or client secret', async () => {
    const store = createStore();
    const legacy = {
      ...clientParams,
      clientId: 'user-client',
      clientSecret: 'user-secret',
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
    };
    await store.write('session_legacy', legacy);
    const { fetchFn } = authorizationServerFetch('https://b.example/');
    const resumed = await getMcpClientBySessionId({ sessionId: 'legacy', store });

    await expect(
      auth(resumed.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
    ).rejects.toThrow(notBound('legacy'));
    expect(credentialRequests(fetchFn)).toEqual([]);
    expect(await store.read('session_legacy')).toEqual(legacy);
  });

  test.each([
    ['in flight during the upgrade', false],
    ['completed, with its callback replayed', true],
  ] as const)('a pre-upgrade session %s exchanges no code', async (_name, authComplete) => {
    const store = createStore();
    const legacy = {
      ...clientParams,
      clientId: 'user-client',
      clientSecret: 'user-secret',
      ...(authComplete
        ? { accessToken: 'legacy-access', refreshToken: 'legacy-refresh', authComplete }
        : {}),
    };
    await store.write('session_legacy', legacy);
    await store.write('state_legacy-state', 'legacy');
    await store.write('pkce_verifier_legacy-state', 'verifier');
    const { fetchFn } = authorizationServerFetch('https://b.example/');
    vi.stubGlobal('fetch', fetchFn);

    await expect(completeOAuth({ state: 'legacy-state', code: 'code', store })).rejects.toThrow(
      notBound('legacy'),
    );
    expect(credentialRequests(fetchFn)).toEqual([]);
    expect(await store.read('session_legacy')).toEqual(legacy);
  });

  test.each(['known', 'dynamic'] as const)(
    'a %s session exchanges its code only with the authorization server named at the redirect',
    async (kind) => {
      const store = createStore();
      const { authorizationServer, fetchFn } = authorizationServerFetch('https://a.example/');
      const options = { ...clientParams, store, redirect: vi.fn() };
      const initial =
        kind === 'known'
          ? await createKnownCredentialsMcpClient({
              ...options,
              clientId: 'user-client',
              clientSecret: 'user-secret',
            })
          : await createDynamicallyRegisteredMcpClient(options);
      await expect(
        auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
      ).resolves.toBe('REDIRECT');
      const bound = await store.read(`session_${initial.sessionId}`);

      authorizationServer.url = 'https://b.example/';
      fetchFn.mockClear();
      const state = await initial.authProvider.state!();
      // The initializer starting another authorization meets the binding.
      await expect(
        auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
      ).rejects.toThrow(
        'OAuth client information is bound to authorization server https://a.example/ and is not presented to https://b.example/',
      );
      expect(credentialRequests(fetchFn)).toEqual([]);
      expect(await store.read(`session_${initial.sessionId}`)).toEqual(bound);

      // The callback restores the redirect's discovery state instead.
      const resumed = await getMcpClientBySessionId({ sessionId: initial.sessionId, store, state });
      await expect(
        auth(resumed.authProvider, {
          serverUrl: clientParams.mcpEndpoint,
          authorizationCode: 'code',
          fetchFn,
        }),
      ).resolves.toBe('AUTHORIZED');
      expect(credentialRequests(fetchFn)).toEqual(['POST https://a.example/token']);
    },
  );

  test('a replayed callback for a completed session exchanges no code at another authorization server', async () => {
    const store = createStore();
    const { authorizationServer, fetchFn } = authorizationServerFetch('https://a.example/');
    vi.stubGlobal('fetch', fetchFn);
    const initial = await createKnownCredentialsMcpClient({
      ...clientParams,
      store,
      redirect: vi.fn(),
      clientId: 'user-client',
      clientSecret: 'user-secret',
    });
    await expect(
      auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
    ).resolves.toBe('REDIRECT');
    const state = await initial.authProvider.state!();
    await completeOAuth({ state, code: 'code', store });
    const completed = await store.read(`session_${initial.sessionId}`);
    expect(completed).toMatchObject({ authComplete: true, accessToken: 'access-from-a.example' });

    authorizationServer.url = 'https://b.example/';
    fetchFn.mockClear();
    await expect(completeOAuth({ state, code: 'replayed', store })).rejects.toThrow(
      'OAuth client information is bound to authorization server https://a.example/ and is not presented to https://b.example/',
    );
    expect(credentialRequests(fetchFn)).toEqual([]);
    expect(await store.read(`session_${initial.sessionId}`)).toEqual(completed);
  });

  test('a provider created before the session was bound presents the binding saved by another', async () => {
    const store = createStore();
    const { authorizationServer, fetchFn } = authorizationServerFetch('https://a.example/');
    const initial = await createKnownCredentialsMcpClient({
      ...clientParams,
      store,
      redirect: vi.fn(),
      clientId: 'user-client',
      clientSecret: 'user-secret',
    });
    const state = await initial.authProvider.state!();
    // Both providers exist before the first binding.
    const stale = await getMcpClientBySessionId({ sessionId: initial.sessionId, store, state });
    await expect(
      auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
    ).resolves.toBe('REDIRECT');
    const bound = await store.read(`session_${initial.sessionId}`);

    authorizationServer.url = 'https://b.example/';
    await expect(
      stale.authProvider.saveTokens({ ...tokens, issuer: 'https://b.example/' }),
    ).rejects.toThrow(
      'is bound to authorization server https://a.example/ and does not save tokens for https://b.example/',
    );
    expect(credentialRequests(fetchFn)).toEqual([]);
    expect(await store.read(`session_${initial.sessionId}`)).toEqual(bound);

    // The callback presents the binding and discovery state saved by the other.
    await expect(
      auth(stale.authProvider, {
        serverUrl: clientParams.mcpEndpoint,
        authorizationCode: 'code',
        fetchFn,
      }),
    ).resolves.toBe('AUTHORIZED');
    expect(credentialRequests(fetchFn)).toEqual(['POST https://a.example/token']);
  });

  test('a save does not replace client information or tokens bound to another issuer', async () => {
    const store = createStore();
    const initial = await createDynamicallyRegisteredMcpClient({
      ...clientParams,
      store,
      redirect: vi.fn(),
    });
    // Taken while the session is unbound, as a provider holding an outdated copy would.
    const save = initial.authProvider.saveClientInformation!;
    const bound = {
      ...((await store.read(`session_${initial.sessionId}`)) as Record<string, JsonSerializable>),
      oauthClientInformation: clientInformation,
      oauthTokens: tokens,
    } as JsonSerializable;
    await store.write(`session_${initial.sessionId}`, bound);

    const other = 'https://other-auth.example/';
    await expect(save({ ...clientInformation, client_id: 'other', issuer: other })).rejects.toThrow(
      `is bound to authorization server ${issuer} and does not save client information for ${other}`,
    );
    await expect(initial.authProvider.saveTokens({ ...tokens, issuer: other })).rejects.toThrow(
      `is bound to authorization server ${issuer} and does not save tokens for ${other}`,
    );
    expect(await store.read(`session_${initial.sessionId}`)).toEqual(bound);

    // The same issuer still saves.
    await initial.authProvider.saveTokens({ ...tokens, access_token: 'next-access' });
    expect(await store.read(`session_${initial.sessionId}`)).toMatchObject({
      accessToken: 'next-access',
      oauthTokens: { issuer },
    });
  });

  test('a dynamic initializer that registered at one issuer does not register again at another', async () => {
    const store = createStore();
    const { authorizationServer, fetchFn } = authorizationServerFetch('https://a.example/');
    const initial = await createDynamicallyRegisteredMcpClient({
      ...clientParams,
      store,
      redirect: vi.fn(),
    });
    await expect(
      auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
    ).resolves.toBe('REDIRECT');
    const registered = await store.read(`session_${initial.sessionId}`);
    expect(registered).toMatchObject({
      clientId: 'registered-at-a.example',
      oauthClientInformation: { issuer: 'https://a.example/' },
    });

    authorizationServer.url = 'https://b.example/';
    fetchFn.mockClear();
    await expect(
      auth(initial.authProvider, { serverUrl: clientParams.mcpEndpoint, fetchFn }),
    ).rejects.toThrow(
      'OAuth client information is bound to authorization server https://a.example/ and is not presented to https://b.example/',
    );
    expect(credentialRequests(fetchFn)).toEqual([]);
    expect(await store.read(`session_${initial.sessionId}`)).toEqual(registered);
  });
});
