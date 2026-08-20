import { randomUUID } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
  validateAuthorizationResponseIssuer,
  validateClientMetadataUrl,
} from '@modelcontextprotocol/client';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

const CODE_VERIFIER_PREFIX = 'pkce_verifier_';
const STATE_PREFIX = 'state_';
const SESSION_PREFIX = 'session_';

export type JsonSerializable =
  | null
  | undefined
  | boolean
  | number
  | string
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

export interface McpClientStore {
  write: (key: string, value: JsonSerializable) => Promise<void>;
  read: (key: string) => Promise<JsonSerializable>;
}

/**
 * This function is used to complete the OAuth flow. It is used in the OAuth
 * callback route to complete the OAuth flow given a state and auth code.
 */
export async function completeAuthWithCode({
  state,
  code,
  iss,
  store,
}: {
  /**
   * The authorization code returned from the auth provider via querystring.
   * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1
   */
  code: string;
  /**
   * The state returned from the auth provider via querystring.
   * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.1
   */
  state: string;
  /**
   * The issuer identifier returned from the auth provider via querystring, if
   * present. Validated against the recorded issuer before the code is
   * redeemed, defending against authorization server mix-up attacks.
   * @see https://datatracker.ietf.org/doc/html/rfc9207
   */
  iss?: string;
  /**
   * A persistent store for auth data
   * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
   */
  store: McpClientStore;
}) {
  const sessionId = await store.read(`${STATE_PREFIX}${state}`);

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error(`No session id associated with state "${state}" found in the store`);
  }

  const { transport } = await getClientBySessionId({
    sessionId,
    store,
    state,
  });

  await transport.finishAuth(code, iss);

  // Read the updated client data AFTER finishAuth (which saves tokens)
  const updatedClientData = await getClientData(sessionId, store);

  // write to the store that the auth is complete
  await store.write(`${SESSION_PREFIX}${sessionId}`, {
    ...updatedClientData,
    authComplete: true,
  } as unknown as JsonSerializable);

  return { transport, sessionId };
}

/**
 * Validates the `iss` parameter of an authorization response against the
 * issuer recorded before the redirect, per RFC 9207: a present `iss` must
 * match the recorded issuer, and an absent one is rejected when the server's
 * metadata advertised `authorization_response_iss_parameter_supported`.
 *
 * The success path runs this check automatically inside
 * {@link completeAuthWithCode}. Call this directly for **error responses**
 * (`?error=...&state=...`), which RFC 9207 also covers — a mismatch means the
 * error, including `error_description`, is attacker-controllable and must not
 * be surfaced to the user.
 *
 * @throws an issuer mismatch error when the response fails the check
 */
export async function validateAuthorizationResponseIss({
  state,
  iss,
  store,
}: {
  /**
   * The state returned from the auth provider via querystring.
   */
  state: string;
  /**
   * The issuer identifier returned from the auth provider via querystring, if
   * present.
   */
  iss?: string;
  /**
   * A persistent store for auth data
   * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
   */
  store: McpClientStore;
}): Promise<void> {
  const sessionId = await store.read(`${STATE_PREFIX}${state}`);

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error(`No session id associated with state "${state}" found in the store`);
  }

  const client = await getClientData(sessionId, store);
  const metadata = client.discoveryState?.authorizationServerMetadata as
    | { issuer?: string; authorization_response_iss_parameter_supported?: boolean }
    | undefined;

  validateAuthorizationResponseIssuer({
    iss,
    expectedIssuer: metadata?.issuer ?? client.discoveryState?.authorizationServerUrl,
    issParameterSupported: metadata?.authorization_response_iss_parameter_supported === true,
  });
}

/**
 * Given a client ID and a store, retrieves the client details and returns a
 * transport and MCP client configured with an auth provider.
 */
export async function getClientBySessionId({
  sessionId,
  store,
  state,
}: {
  /**
   * The session id to retrieve the client details for
   */
  sessionId: string;
  /**
   * A persistent store for auth data
   * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
   */
  store: McpClientStore;
  /**
   * If using this function in the OAuth callback route, pass in the state to
   * ensure that PKCE can run correctly.
   */
  state?: string;
}) {
  const client = await getClientData(sessionId, store);
  const { persist, providerHooks } = sessionPersistence(client, store, sessionId);

  const redirectUris = [client.oauthRedirectUrl, ...(client.oauthAdditionalRedirectUrls ?? [])];

  const authProvider: OAuthClientProvider = {
    redirectUrl: client.oauthRedirectUrl,
    clientMetadataUrl: client.oauthClientMetadataUrl,
    clientMetadata: {
      redirect_uris: redirectUris,
      application_type: explicitApplicationType(redirectUris),
      logo_uri: undefined,
      tos_uri: undefined,
    },
    clientInformation: () => {
      if (!client.clientId) return undefined;

      // the issuer stamp lets the SDK refuse to send these credentials to a
      // different authorization server (SEP-2352); a stamped mismatch is
      // discarded and triggers re-registration
      return {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        issuer: client.issuer,
      };
    },
    saveClientInformation: async (newInfo: StoredOAuthClientInformation) => {
      // tokens issued by the previous authorization server must never be
      // replayed against the one these credentials were registered with
      if (client.issuer && newInfo.issuer && client.issuer !== newInfo.issuer) {
        delete client.accessToken;
        delete client.refreshToken;
        delete client.authComplete;
      }

      Object.assign(client, {
        clientId: newInfo.client_id,
        clientSecret: newInfo.client_secret,
        issuer: newInfo.issuer,
      });
      await persist();
    },
    tokens: (): StoredOAuthTokens | undefined => {
      if (!client.accessToken) return undefined;
      return { access_token: client.accessToken, token_type: 'Bearer', issuer: client.issuer };
    },
    saveTokens: async ({ access_token, refresh_token, issuer }) => {
      Object.assign(client, {
        accessToken: access_token,
        refreshToken: refresh_token,
        issuer: issuer ?? client.issuer,
      });
      await persist();
    },
    ...providerHooks,
    redirectToAuthorization: unexpectedFunctionCall(
      'redirectToAuthorization',
      'getting an existing client',
    ),
    saveCodeVerifier: unexpectedFunctionCall('saveCodeVerifier', 'getting an existing client'),
    codeVerifier: async (): Promise<string> => {
      if (!state) {
        throw new Error(
          'The state argument is required to retrieve a code verifier for an already initialized client',
        );
      }

      const storedVerifier = await store.read(`${CODE_VERIFIER_PREFIX}${state}`);

      if (!storedVerifier || typeof storedVerifier !== 'string') {
        throw new Error(`No code verifier found for state "${state}" in the store`);
      }

      return storedVerifier;
    },
  };

  return createReturnValue(client, authProvider, sessionId);
}

// Return type for known credentials and dynamically registered clients
export interface McpClientReturnType {
  /**
   * Represents a session associated with the connected MCP service endpoint.
   */
  sessionId: string;
  /**
   * Calling this function will initialize a connect to the MCP service.
   */
  connect: () => void;
  /**
   * Lower level primitive, likely not necessary for use
   * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/streamableHttp.ts#L119
   */
  transport: StreamableHTTPClientTransport;
  /**
   * Lower level primitive, likely not necessary for use
   * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/index.ts#L81
   */
  client: Client;
  /**
   * Lower level primitive, likely not necessary for use
   * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/auth.ts#L13
   */
  authProvider: OAuthClientProvider;
}

export interface CreateKnownCredentialsMcpClientParams {
  /**
   * OAuth client id, expected to be collected via user input
   */
  clientId: string;
  /**
   * OAuth client secret, expected to be collected via user input
   */
  clientSecret: string;
  /**
   * The endpoint of the MCP service, expected to be collected via user input
   */
  mcpEndpoint: string;
  /**
   * OAuth redirect URL - after the user consents, this route will get
   * back the authorization code and state.
   */
  oauthRedirectUrl: string;
  /**
   * OAuth scopes that you'd like to request access to
   */
  oauthScopes?: string;
  /**
   * Name passed to the client created by the MCP SDK
   * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
   */
  mcpClientName: string;
  /**
   * Version number passed to the client created by the MCP SDK
   * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
   */
  mcpClientVersion: string;
  /**
   * A function that, when called with a url, will redirect to the given url
   */
  redirect: (url: string) => void;
  /**
   * A persistent store for auth data
   * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
   */
  store: McpClientStore;
}

/**
 * Creates a new MCP client and transport for the first time with a known
 * client id and secret for an existing oauth client.
 */
export async function createKnownCredentialsMcpClient({
  redirect,
  store,
  ...clientParams
}: CreateKnownCredentialsMcpClientParams): Promise<McpClientReturnType> {
  const state = randomUUID();
  const sessionId = randomUUID();

  const client: ClientData = { ...clientParams };

  // associate state with session id
  // in the oauth callback, we only have the state, and will need to get the
  // client information, so we need this to resolve the session id
  await store.write(`${STATE_PREFIX}${state}`, sessionId);

  const { persist, providerHooks } = sessionPersistence(client, store, sessionId);

  // persist all the client details to the store, we will need them to
  // re-create the client later in the oauth callback and any mcp call endpoints
  await persist();

  // there's some non-dry code between this and the dynamically registered
  // client, but this is on purpose for flexibility and clarity.
  const authProvider: OAuthClientProvider = {
    redirectUrl: client.oauthRedirectUrl,
    clientMetadata: {
      redirect_uris: [client.oauthRedirectUrl],
      scope: client.oauthScopes,
      logo_uri: undefined,
      tos_uri: undefined,
    },
    state: () => state,
    clientInformation: () => ({
      client_id: client.clientId!,
      client_secret: client.clientSecret,
      issuer: client.issuer,
    }),
    // pre-registered credentials are never re-registered, but the SDK
    // back-stamps the authorization server's issuer onto them on first use
    // (SEP-2352), which arrives through this method
    saveClientInformation: async (newInfo: StoredOAuthClientInformation) => {
      Object.assign(client, { issuer: newInfo.issuer });
      await persist();
    },
    // it's impossible that we have an access token at this point, so we always
    // return undefined
    tokens: () => undefined,
    // called in the oauth callback route
    saveTokens: unexpectedFunctionCall('saveTokens', 'initializing a known credentials client'),
    ...providerHooks,
    redirectToAuthorization: (url) => {
      redirect(url.toString());
    },
    saveCodeVerifier: async (verifier: string) => {
      await store.write(`${CODE_VERIFIER_PREFIX}${state}`, verifier);
    },
    // called in the oauth callback route
    codeVerifier: unexpectedFunctionCall('codeVerifier', 'initializing a known credentials client'),
  };

  return createReturnValue(client, authProvider, sessionId);
}

export interface CreateDynamicallyRegisteredMcpClientParams {
  /**
   * The endpoint of the MCP service, expected to be collected via user input
   */
  mcpEndpoint: string;
  /**
   * OAuth redirect URL - after the user consents, this route will get
   * back the authorization code and state.
   */
  oauthRedirectUrl: string;
  /**
   * Extra redirect URLs to register alongside `oauthRedirectUrl`, for clients
   * that need more than one (for example a web callback plus a custom-scheme
   * callback for a companion native app). When the combined set mixes web and
   * native-class (custom-scheme or loopback) URLs, `application_type` is set
   * to `native` explicitly, since the SDK's derivation is ambiguous for mixed
   * sets.
   */
  oauthAdditionalRedirectUrls?: string[];
  /**
   * The name of the OAuth client to be created with the authorization server
   */
  oauthClientName?: string;
  /**
   * The URI of the OAuth client to be created with the authorization server
   */
  oauthClientUri?: string;
  /**
   * HTTPS URL of a Client ID Metadata Document describing this OAuth client.
   * When the authorization server advertises CIMD support
   * (`client_id_metadata_document_supported`), this URL is used directly as
   * the `client_id` and dynamic client registration is skipped; otherwise the
   * flow falls back to dynamic registration.
   * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document
   */
  oauthClientMetadataUrl?: string;
  /**
   * OAuth scopes that you'd like to request access to
   */
  oauthScopes?: string;
  /**
   * Whether the OAuth client is public or confidential
   * @see https://datatracker.ietf.org/doc/html/rfc6749#section-2.1
   */
  oauthPublicClient?: boolean;
  /**
   * Name passed to the client created by the MCP SDK
   * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
   */
  mcpClientName: string;
  /**
   * Version number passed to the client created by the MCP SDK
   * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
   */
  mcpClientVersion: string;
  /**
   * A function that, when called with a url, will redirect to the given url
   */
  redirect: (url: string) => void;
  /**
   * A persistent store for auth data
   * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
   */
  store: McpClientStore;
}

/**
 * Creates a new MCP client and transport for the first time that is assumed
 * to need to be dynamically registered with an authorization server.
 */
export async function createDynamicallyRegisteredMcpClient({
  redirect,
  store,
  ...clientParams
}: CreateDynamicallyRegisteredMcpClientParams): Promise<McpClientReturnType> {
  // fail fast on a malformed CIMD URL, before any flow state is persisted
  validateClientMetadataUrl(clientParams.oauthClientMetadataUrl);

  const state = randomUUID();
  const sessionId = randomUUID();

  // this is our in-memory client object, we will update it with the client id
  // and secret after dynamic registration is complete
  const client: ClientData = {
    ...clientParams,
    clientId: undefined,
    clientSecret: undefined,
  };

  // associate state with session id
  // in the oauth callback, we only have the state, and will need to get the
  // client information, so we need this to resolve the session id
  await store.write(`${STATE_PREFIX}${state}`, sessionId);

  const { persist, providerHooks } = sessionPersistence(client, store, sessionId);

  // persist all the client details to the store, we will need them to
  // re-create the client later in the oauth callback and any mcp call endpoints
  await persist();

  const redirectUris = [client.oauthRedirectUrl, ...(client.oauthAdditionalRedirectUrls ?? [])];

  const authProvider: OAuthClientProvider = {
    redirectUrl: client.oauthRedirectUrl,
    // when the authorization server supports CIMD, this URL becomes the
    // client_id and dynamic registration is skipped
    clientMetadataUrl: client.oauthClientMetadataUrl,
    // this information is used to create an oauth client via dynamic client
    // registration
    clientMetadata: {
      redirect_uris: redirectUris,
      application_type: explicitApplicationType(redirectUris),
      client_name: client.oauthClientName || client.mcpClientName,
      client_uri: client.oauthClientUri,
      scope: client.oauthScopes,
      token_endpoint_auth_method: client.oauthPublicClient ? 'none' : undefined,
      logo_uri: undefined,
      tos_uri: undefined,
    },
    state: () => state,
    // this is called initially to see if there's an existing oauth client. if
    // it returns undefined, the MCP SDK assumes that dynamic registration is
    // needed. If dynamic registration is complete, we will have stored the
    // oauth client credentials and will return them here, which the MCP SDK
    // uses to construct the authorization url with the client id.
    clientInformation: () => {
      if (!client.clientId) {
        return undefined;
      }

      return {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        issuer: client.issuer,
      };
    },
    // this is called after a new oauth client is created, so we now have a
    // client id and secret, stamped with the issuer of the authorization
    // server that created it (SEP-2352)
    saveClientInformation: async (newInfo: StoredOAuthClientInformation) => {
      Object.assign(client, {
        clientId: newInfo.client_id,
        clientSecret: newInfo.client_secret,
        issuer: newInfo.issuer,
      });
      await persist();
    },
    // it's impossible that we have an access token at this point, so we always
    // return undefined
    tokens: () => undefined,
    // called in the oauth callback route
    saveTokens: async ({ access_token, refresh_token, issuer }) => {
      Object.assign(client, {
        accessToken: access_token,
        refreshToken: refresh_token,
        issuer: issuer ?? client.issuer,
      });
      await persist();
    },
    ...providerHooks,
    redirectToAuthorization: (url) => {
      redirect(url.toString());
    },
    // since the code verifier is saved before the client is registered, we
    // store it using the state as the key
    saveCodeVerifier: async (verifier: string) => {
      await store.write(`${CODE_VERIFIER_PREFIX}${state}`, verifier);
    },
    // called in the oauth callback route
    codeVerifier: unexpectedFunctionCall(
      'codeVerifier',
      'initializing a dynamically registered client',
    ),
  };

  return createReturnValue(client, authProvider, sessionId);
}

/**
 * Both known credentials and dynamically registered clients return the same
 * values, so we abstract the common code here.
 */
function createReturnValue(
  client: ClientData,
  authProvider: OAuthClientProvider,
  sessionId: string,
) {
  const transport = new StreamableHTTPClientTransport(new URL(client.mcpEndpoint), {
    authProvider,
  });

  const mcpClient = new Client({
    name: client.mcpClientName,
    version: client.mcpClientVersion,
  });

  return {
    sessionId,
    connect: _connect.bind(null, mcpClient, transport),
    transport,
    client: mcpClient,
    clientData: client,
    authProvider,
  };
}

/**
 * A convenience function to connect the client with the provided transport.
 */
function _connect(client: Client, transport: StreamableHTTPClientTransport) {
  return client.connect(transport);
}

/**
 * The MCP SDK is designed as if the same AuthProvider can be stored in memory
 * and used across multiple different routes, but in production code this isn't
 * realistic. We know that during certain phases of the auth flow, certain
 * methods should not be called, so we use this function to throw a nice clear
 * error if they are.
 */
function unexpectedFunctionCall(name: string, phase: string) {
  return () => {
    throw new Error(`Unexpected call to AuthProvider method "${name}" when ${phase}.`);
  };
}

/**
 * The data that is stored in the store for a mcp client.
 */
export interface ClientData {
  oauthRedirectUrl: string;
  mcpEndpoint: string;
  mcpClientName: string;
  mcpClientVersion: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  authComplete?: boolean;
  oauthClientName?: string;
  oauthClientUri?: string;
  oauthClientMetadataUrl?: string;
  oauthAdditionalRedirectUrls?: string[];
  oauthScopes?: string;
  oauthPublicClient?: boolean;
  /**
   * The issuer identifier of the authorization server that the persisted
   * client credentials and tokens were issued by (SEP-2352). Credentials
   * stamped for one issuer are never sent to a different one.
   */
  issuer?: string;
  /**
   * OAuth discovery results persisted across the redirect round-trip, so the
   * callback leg can verify it is talking to the same authorization server it
   * redirected to, without re-running discovery.
   */
  discoveryState?: OAuthDiscoveryState;
}

/**
 * Pins `application_type` for a redirect URI set that mixes web and
 * native-class (custom-scheme or loopback) URLs, which is ambiguous under
 * OIDC DCR §2 and left to a heuristic by the SDK. A registration carrying a
 * custom-scheme or loopback URI is a native app per RFC 8252, which also
 * permits claiming https URLs, so mixed sets are pinned to `native`. Unmixed
 * sets return undefined — the SDK derives the correct value for those.
 */
function explicitApplicationType(redirectUris: string[]): 'native' | undefined {
  let hasWeb = false;
  let hasNative = false;

  for (const raw of redirectUris) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }

    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    const isLoopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';

    if (!isHttp || isLoopback) {
      hasNative = true;
    } else {
      hasWeb = true;
    }
  }

  return hasWeb && hasNative ? 'native' : undefined;
}

/**
 * The persistence plumbing every provider phase shares verbatim: writing the
 * session record, round-tripping discovery state across the redirect, and
 * credential invalidation. Kept out of the per-phase provider literals — the
 * intentional non-DRY between those covers phase-specific auth behavior, not
 * provider-agnostic storage.
 */
function sessionPersistence(client: ClientData, store: McpClientStore, sessionId: string) {
  const persist = () =>
    store.write(`${SESSION_PREFIX}${sessionId}`, client as unknown as JsonSerializable);

  const providerHooks = {
    saveDiscoveryState: async (discoveryState: OAuthDiscoveryState) => {
      client.discoveryState = discoveryState;
      await persist();
    },
    discoveryState: () => client.discoveryState,
    invalidateCredentials: async (
      scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
    ) => {
      applyCredentialInvalidation(client, scope);
      await persist();
    },
  } satisfies Partial<OAuthClientProvider>;

  return { persist, providerHooks };
}

/**
 * Clears persisted credential material when the SDK signals that it is no
 * longer valid. The `verifier` scope is a no-op here because code verifiers
 * are keyed by OAuth state, not by session.
 */
function applyCredentialInvalidation(
  client: ClientData,
  scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
) {
  if (scope === 'all' || scope === 'client') {
    delete client.clientId;
    delete client.clientSecret;
    delete client.issuer;
  }

  // tokens issued to an invalidated client registration die with it
  if (scope === 'all' || scope === 'client' || scope === 'tokens') {
    delete client.accessToken;
    delete client.refreshToken;
    delete client.authComplete;
  }

  if (scope === 'all' || scope === 'discovery') {
    delete client.discoveryState;
  }
}

/**
 * Handles typing for reading client data our of the store by session id.
 */
async function getClientData(sessionId: string, store: McpClientStore) {
  const clientData = await store.read(`${SESSION_PREFIX}${sessionId}`);

  if (
    !clientData ||
    typeof clientData !== 'object' ||
    clientData === null ||
    Array.isArray(clientData)
  ) {
    throw new Error(`Session with ID "${sessionId}" not found in store`);
  }

  return clientData as unknown as ClientData;
}
