import {
  StreamableHTTPClientTransport,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  completeAuthWithCode,
  createDynamicallyRegisteredMcpClient,
  createKnownCredentialsMcpClient,
  getClientBySessionId,
  type JsonSerializable,
  type McpClientStore,
} from './client';

class MemoryStore implements McpClientStore {
  values = new Map<string, JsonSerializable>();

  async write(key: string, value: JsonSerializable) {
    this.values.set(key, structuredClone(value));
  }

  async read(key: string) {
    return structuredClone(this.values.get(key));
  }
}

const knownClient = {
  clientId: 'client_123',
  clientSecret: 'secret_123',
  mcpEndpoint: 'https://mcp.example.com/mcp',
  oauthRedirectUrl: 'https://app.example.com/oauth/callback',
  oauthScopes: 'read write',
  mcpClientName: 'test-client',
  mcpClientVersion: '1.0.0',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MCP v2 OAuth persistence', () => {
  test('probes v2 and falls back to the legacy handshake', async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const message = JSON.parse(String(init?.body)) as {
          id?: string | number;
          method: string;
        };
        methods.push(message.method);

        if (message.method === 'server/discover') {
          return new Response(null, { status: 404 });
        }

        if (message.method === 'initialize') {
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'legacy-server', version: '1.0.0' },
            },
          });
        }

        if (message.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }

        throw new Error(`Unexpected MCP method: ${message.method}`);
      }),
    );
    const store = new MemoryStore();
    const result = await createKnownCredentialsMcpClient({
      ...knownClient,
      redirect: vi.fn(),
      store,
    });

    await result.connect();

    expect(result.client.getProtocolEra()).toBe('legacy');
    expect(methods).toContain('server/discover');
    expect(methods).toContain('initialize');
    await result.client.close();
  });

  test('preserves full client information, token sets, discovery state, and concurrent fields', async () => {
    const store = new MemoryStore();
    const result = await createKnownCredentialsMcpClient({
      ...knownClient,
      redirect: vi.fn(),
      store,
    });

    expect(
      (
        result.client as unknown as {
          _versionNegotiation?: { mode?: string };
        }
      )._versionNegotiation,
    ).toEqual({ mode: 'auto' });
    expect(await result.authProvider.clientInformation()).toEqual({
      client_id: 'client_123',
      client_secret: 'secret_123',
    });
    expect(result.authProvider.clientMetadata).toMatchObject({
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
    });

    const sessionKey = `session_${result.sessionId}`;
    const stored = await store.read(sessionKey);
    await store.write(sessionKey, {
      ...(stored as Record<string, JsonSerializable>),
      authComplete: true,
    });

    const clientInformation: StoredOAuthClientInformation = {
      client_id: 'registered_client',
      client_secret: 'registered_secret',
      client_id_issued_at: 1_700_000_000,
      client_secret_expires_at: 1_800_000_000,
      issuer: 'https://accounts.example.com',
    };
    await result.authProvider.saveClientInformation?.(clientInformation);

    const tokens: StoredOAuthTokens = {
      access_token: 'access_token',
      refresh_token: 'refresh_token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read write',
      issuer: 'https://accounts.example.com',
    };
    await result.authProvider.saveTokens(tokens);

    const discoveryState: OAuthDiscoveryState = {
      authorizationServerUrl: 'https://accounts.example.com',
      authorizationServerMetadata: {
        issuer: 'https://accounts.example.com',
        authorization_endpoint: 'https://accounts.example.com/oauth/authorize',
        token_endpoint: 'https://accounts.example.com/oauth/token',
        response_types_supported: ['code'],
      },
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    };
    await result.authProvider.saveDiscoveryState?.(discoveryState);

    expect(await result.authProvider.clientInformation()).toEqual(clientInformation);
    expect(await result.authProvider.tokens()).toEqual(tokens);
    expect(await result.authProvider.discoveryState?.()).toEqual(discoveryState);
    expect(await store.read(sessionKey)).toMatchObject({ authComplete: true });
  });

  test('creates fresh state and verifier storage for authorization after restoring a session', async () => {
    const store = new MemoryStore();
    const redirect = vi.fn();
    const created = await createDynamicallyRegisteredMcpClient({
      mcpEndpoint: knownClient.mcpEndpoint,
      oauthRedirectUrl: knownClient.oauthRedirectUrl,
      mcpClientName: knownClient.mcpClientName,
      mcpClientVersion: knownClient.mcpClientVersion,
      redirect,
      store,
    });
    const restored = await getClientBySessionId({
      sessionId: created.sessionId,
      store,
      redirect,
    });

    const firstState = await restored.authProvider.state?.();
    expect(firstState).toEqual(expect.any(String));
    await restored.authProvider.saveCodeVerifier('first_verifier');
    expect(await restored.authProvider.codeVerifier()).toBe('first_verifier');
    expect(await store.read(`state_${firstState}`)).toBe(created.sessionId);

    const secondState = await restored.authProvider.state?.();
    expect(secondState).not.toBe(firstState);
    await restored.authProvider.saveCodeVerifier('second_verifier');
    expect(await restored.authProvider.codeVerifier()).toBe('second_verifier');
    expect(await store.read(`state_${secondState}`)).toBe(created.sessionId);

    await restored.authProvider.redirectToAuthorization(
      new URL('https://accounts.example.com/oauth/authorize'),
    );
    expect(redirect).toHaveBeenLastCalledWith('https://accounts.example.com/oauth/authorize');
  });

  test('invalidates each v2 credential scope', async () => {
    const store = new MemoryStore();
    const result = await createKnownCredentialsMcpClient({
      ...knownClient,
      redirect: vi.fn(),
      store,
    });
    const state = await result.authProvider.state?.();
    await result.authProvider.saveCodeVerifier('verifier');
    await result.authProvider.saveTokens({
      access_token: 'access_token',
      token_type: 'Bearer',
      issuer: 'https://accounts.example.com',
    });
    await result.authProvider.saveDiscoveryState?.({
      authorizationServerUrl: 'https://accounts.example.com',
    });

    await result.authProvider.invalidateCredentials?.('all');

    expect(await result.authProvider.clientInformation()).toBeUndefined();
    expect(await result.authProvider.tokens()).toBeUndefined();
    expect(await result.authProvider.discoveryState?.()).toBeUndefined();
    expect(await store.read(`pkce_verifier_${state}`)).toBeNull();
  });
});

describe('completeAuthWithCode', () => {
  test('passes the callback issuer to the SDK and marks the session complete', async () => {
    const store = new MemoryStore();
    const created = await createKnownCredentialsMcpClient({
      ...knownClient,
      redirect: vi.fn(),
      store,
    });
    const state = await created.authProvider.state?.();
    await created.authProvider.saveCodeVerifier('verifier');
    const finishAuth = vi
      .spyOn(StreamableHTTPClientTransport.prototype, 'finishAuth')
      .mockResolvedValue();

    const completed = await completeAuthWithCode({
      state: state!,
      code: 'authorization_code',
      iss: 'https://accounts.example.com',
      store,
    });

    const callbackParams = finishAuth.mock.calls[0]?.[0] as unknown;
    expect(callbackParams).toBeInstanceOf(URLSearchParams);
    expect((callbackParams as URLSearchParams).get('code')).toBe('authorization_code');
    expect((callbackParams as URLSearchParams).get('iss')).toBe('https://accounts.example.com');
    expect(completed.sessionId).toBe(created.sessionId);
    expect(await store.read(`session_${created.sessionId}`)).toMatchObject({
      authComplete: true,
    });
  });

  test('passes full callback parameters to the SDK and derives the stored state', async () => {
    const store = new MemoryStore();
    const created = await createKnownCredentialsMcpClient({
      ...knownClient,
      redirect: vi.fn(),
      store,
    });
    const state = await created.authProvider.state?.();
    await created.authProvider.saveCodeVerifier('verifier');
    const finishAuth = vi
      .spyOn(StreamableHTTPClientTransport.prototype, 'finishAuth')
      .mockResolvedValue();
    const callbackParams = new URLSearchParams({
      code: 'authorization_code',
      state: state!,
      iss: 'https://accounts.example.com',
      session_state: 'future_parameter',
    });

    await completeAuthWithCode({ callbackParams, store });

    const forwarded = finishAuth.mock.calls[0]?.[0] as unknown as URLSearchParams;
    expect(forwarded.get('state')).toBe(state);
    expect(forwarded.get('iss')).toBe('https://accounts.example.com');
    expect(forwarded.get('session_state')).toBe('future_parameter');
  });
});
