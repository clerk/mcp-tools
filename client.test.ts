import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, test, vi } from 'vitest';
import {
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

/** The requests that carry credentials, as `METHOD url`. */
function credentialRequests(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetchFn.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([input]) => `POST ${String(input instanceof Request ? input.url : input)}`);
}

describe('OAuth credential persistence', () => {
  test.each(['known', 'dynamic'] as const)(
    '%s client retains complete SDK credentials',
    async (kind) => {
      const store = createStore();
      const options = { ...clientParams, store, redirect: vi.fn() };
      const initial =
        kind === 'known'
          ? await createKnownCredentialsMcpClient({
              ...options,
              clientId: 'client-id',
              clientSecret: 'client-secret',
            })
          : await createDynamicallyRegisteredMcpClient(options);

      await initial.authProvider.saveClientInformation!(clientInformation);
      expect(await initial.authProvider.clientInformation()).toEqual(clientInformation);

      const resumed = await getMcpClientBySessionId({ sessionId: initial.sessionId, store });
      expect(await resumed.authProvider.clientInformation()).toEqual(clientInformation);
      await resumed.authProvider.saveTokens(tokens);
      expect(await resumed.authProvider.tokens()).toEqual(tokens);
      // Saving tokens must not erase the issuer saved immediately before them.
      expect(await resumed.authProvider.clientInformation()).toEqual(clientInformation);

      const reloaded = await getMcpClientBySessionId({ sessionId: initial.sessionId, store });
      expect(await reloaded.authProvider.clientInformation()).toEqual(clientInformation);
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

  test('legacy sessions remain readable and sequential saves merge the latest session', async () => {
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
    expect(await resumed.authProvider.clientInformation()).toEqual({
      client_id: 'legacy-client',
      client_secret: 'legacy-secret',
    });
    expect(await resumed.authProvider.tokens()).toEqual({
      access_token: 'legacy-access',
      token_type: 'Bearer',
    });

    await store.write('session_legacy', { ...legacy, authComplete: true });
    await resumed.authProvider.saveClientInformation!(clientInformation);
    await resumed.authProvider.saveTokens(tokens);
    expect(await store.read('session_legacy')).toMatchObject({
      authComplete: true,
      oauthClientInformation: clientInformation,
      oauthTokens: tokens,
    });
  });

  test('an unregistered session returns no client information', async () => {
    const store = createStore();
    await store.write('session_empty', clientParams);
    const resumed = await getMcpClientBySessionId({ sessionId: 'empty', store });
    expect(await resumed.authProvider.clientInformation()).toBeUndefined();
  });

  test('SDK code exchange binds legacy credentials before saving tokens', async () => {
    const store = createStore();
    const initial = await createKnownCredentialsMcpClient({
      ...clientParams,
      store,
      redirect: vi.fn(),
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    const state = await initial.authProvider.state!();
    await initial.authProvider.saveCodeVerifier('verifier');
    const resumed = await getMcpClientBySessionId({ sessionId: initial.sessionId, store, state });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
      }),
    );

    await expect(
      auth(
        { ...resumed.authProvider, discoveryState },
        {
          serverUrl: clientParams.mcpEndpoint,
          authorizationCode: 'code',
          fetchFn,
        },
      ),
    ).resolves.toBe('AUTHORIZED');
    const reloaded = await getMcpClientBySessionId({ sessionId: initial.sessionId, store });
    expect(await reloaded.authProvider.clientInformation()).toMatchObject({ issuer });
    expect(await reloaded.authProvider.tokens()).toMatchObject({ issuer });
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

  test('a pre-upgrade session does not send its refresh token or client secret to an unverified issuer', async () => {
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
    ).rejects.toThrow('Unexpected call to AuthProvider method "saveCodeVerifier"');
    expect(credentialRequests(fetchFn)).toEqual([]);
    expect(await store.read('session_legacy')).toEqual(legacy);
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
