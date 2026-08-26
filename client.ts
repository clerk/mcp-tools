import { randomUUID } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

const CODE_VERIFIER_PREFIX = 'pkce_verifier_';
const STATE_PREFIX = 'state_';
const SESSION_PREFIX = 'session_';

/** Values accepted by an {@link McpClientStore}. */
export type JsonSerializable =
  | null
  | undefined
  | boolean
  | number
  | string
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

/**
 * Persistent storage used across the OAuth redirect and later MCP requests.
 *
 * Implementations must preserve nested objects and must not log stored OAuth
 * credentials. The built-in Redis, PostgreSQL, and SQLite stores implement
 * this interface. The file-system store is suitable for local development.
 */
export interface McpClientStore {
  write: (key: string, value: JsonSerializable) => Promise<void>;
  read: (key: string) => Promise<JsonSerializable>;
}

/**
 * Parameters for {@link completeAuthWithCode}.
 *
 * Pass `callbackParams` when possible. The legacy `code`, `state`, and `iss`
 * fields remain available for callers that already parse the callback.
 */
export type CompleteAuthWithCodeParams =
  | {
      callbackParams: URLSearchParams;
      store: McpClientStore;
      code?: never;
      state?: never;
      iss?: never;
    }
  | {
      callbackParams?: never;
      code: string;
      state: string;
      iss?: string;
      store: McpClientStore;
    };

/**
 * Completes OAuth, saves the full token set, and returns the associated MCP
 * session. The preferred form forwards all callback parameters to the SDK so
 * it can validate the authorization-server issuer.
 *
 * @example
 * ```ts
 * const callbackUrl = new URL(request.url);
 * const { sessionId } = await completeAuthWithCode({
 *   callbackParams: callbackUrl.searchParams,
 *   store,
 * });
 * ```
 */
export async function completeAuthWithCode(params: CompleteAuthWithCodeParams) {
  const { store } = params;
  const callbackParams = params.callbackParams
    ? new URLSearchParams(params.callbackParams)
    : new URLSearchParams({ code: params.code, state: params.state });
  if (!params.callbackParams && params.iss) callbackParams.set('iss', params.iss);

  const state = callbackParams.get('state');
  if (!state) {
    throw new Error('No OAuth state found in the callback parameters');
  }

  const sessionId = await store.read(`${STATE_PREFIX}${state}`);

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error(`No session id associated with state "${state}" found in the store`);
  }

  const { transport } = await getClientBySessionId({
    sessionId,
    store,
    state,
  });

  await transport.finishAuth(callbackParams);

  // Read the updated client data AFTER finishAuth (which saves tokens)
  const updatedClientData = await getClientData(sessionId, store);

  // write to the store that the auth is complete
  await writeClientData(sessionId, store, {
    ...updatedClientData,
    authComplete: true,
  });

  return { transport, sessionId };
}

/** Options for restoring a persisted MCP client session. */
export interface GetClientBySessionIdParams {
  /** Session identifier returned by a client creation or OAuth callback helper. */
  sessionId: string;
  /** Persistent storage that contains the session. */
  store: McpClientStore;
  /** OAuth state used while completing a callback and reading its PKCE verifier. */
  state?: string;
  /** Sends the user agent to OAuth when a restored session needs authorization. */
  redirect?: (url: string) => void | Promise<void>;
}

/**
 * Restores a persisted MCP session. Supply `redirect` when the restored
 * session can require OAuth step-up or reauthorization.
 *
 * @example
 * ```ts
 * const session = await getClientBySessionId({
 *   sessionId,
 *   store,
 *   redirect: url => response.redirect(url),
 * });
 *
 * await session.connect();
 * ```
 */
export async function getClientBySessionId({
  sessionId,
  store,
  state,
  redirect,
}: GetClientBySessionIdParams) {
  const client = await getClientData(sessionId, store);
  const authProvider = createOAuthProvider({ client, sessionId, store, state, redirect });

  return createReturnValue(client, authProvider, sessionId);
}

/**
 * An MCP client session with automatic protocol negotiation.
 *
 * `connect()` first probes for MCP 2026-07-28 support and falls back to the
 * legacy handshake when required. After connection, use
 * `client.getProtocolEra()` to inspect the selected era.
 *
 * @example
 * ```ts
 * await session.connect();
 * console.log(session.client.getProtocolEra()); // "modern" or "legacy"
 * ```
 */
export interface McpClientReturnType {
  /**
   * Represents a session associated with the connected MCP service endpoint.
   */
  sessionId: string;
  /**
   * Connects to the MCP service and negotiates the protocol era.
   */
  connect: () => Promise<void>;
  /**
   * Streamable HTTP transport used by `connect()`.
   * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/streamableHttp.ts#L119
   */
  transport: StreamableHTTPClientTransport;
  /**
   * MCP SDK client used to call tools and inspect the negotiated era.
   * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/index.ts#L81
   */
  client: Client;
  /**
   * OAuth provider backed by the configured persistent store.
   * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/auth.ts#L13
   */
  authProvider: OAuthClientProvider;
}

/** Options for a pre-registered OAuth client. */
export interface CreateKnownCredentialsMcpClientParams {
  /**
   * Pre-registered OAuth client identifier.
   */
  clientId: string;
  /**
   * Pre-registered OAuth client secret.
   */
  clientSecret: string;
  /**
   * Absolute Streamable HTTP endpoint for the MCP service.
   */
  mcpEndpoint: string;
  /**
   * Registered callback URL that receives the OAuth response.
   */
  oauthRedirectUrl: string;
  /**
   * Space-delimited OAuth scopes to request.
   */
  oauthScopes?: string;
  /**
   * Client name sent during MCP protocol negotiation.
   * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
   */
  mcpClientName: string;
  /**
   * Client version sent during MCP protocol negotiation.
   * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
   */
  mcpClientVersion: string;
  /**
   * Sends the user agent to the authorization URL.
   */
  redirect: (url: string) => void;
  /**
   * Persistent storage shared by connection and callback handlers.
   * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
   */
  store: McpClientStore;
}

/**
 * Creates an MCP session for an existing OAuth client registration.
 * Connection state, PKCE data, discovery results, and tokens are persisted in
 * `store` so the session can survive redirects and process restarts.
 *
 * @example
 * ```ts
 * const session = await createKnownCredentialsMcpClient({
 *   clientId: process.env.OAUTH_CLIENT_ID!,
 *   clientSecret: process.env.OAUTH_CLIENT_SECRET!,
 *   mcpEndpoint: 'https://api.example.com/mcp',
 *   oauthRedirectUrl: 'https://app.example.com/oauth/callback',
 *   oauthScopes: 'read write',
 *   mcpClientName: 'example-client',
 *   mcpClientVersion: '1.0.0',
 *   redirect: url => response.redirect(url),
 *   store,
 * });
 *
 * await session.connect();
 * ```
 */
export async function createKnownCredentialsMcpClient({
  redirect,
  store,
  ...client
}: CreateKnownCredentialsMcpClientParams): Promise<McpClientReturnType> {
  const state = randomUUID();
  const sessionId = randomUUID();
  const clientData: ClientData = {
    ...client,
    oauthClientInformation: {
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
  };

  // associate state with session id
  // in the oauth callback, we only have the state, and will need to get the
  // client information, so we need this to resolve the session id
  await store.write(`${STATE_PREFIX}${state}`, sessionId);

  // persist all the client details to the store, we will need them to
  // re-create the client later in the oauth callback and any mcp call endpoints
  await writeClientData(sessionId, store, clientData);

  const authProvider = createOAuthProvider({
    client: clientData,
    sessionId,
    store,
    state,
    redirect,
  });

  return createReturnValue(clientData, authProvider, sessionId);
}

/** Options for OAuth Dynamic Client Registration. */
export interface CreateDynamicallyRegisteredMcpClientParams {
  /**
   * Absolute Streamable HTTP endpoint for the MCP service.
   */
  mcpEndpoint: string;
  /**
   * Callback URL advertised during dynamic registration.
   */
  oauthRedirectUrl: string;
  /**
   * OAuth client name advertised during dynamic registration.
   */
  oauthClientName?: string;
  /**
   * Public URI for the OAuth client.
   */
  oauthClientUri?: string;
  /**
   * Space-delimited OAuth scopes to request.
   */
  oauthScopes?: string;
  /**
   * Uses `token_endpoint_auth_method: "none"` when true.
   * @see https://datatracker.ietf.org/doc/html/rfc6749#section-2.1
   */
  oauthPublicClient?: boolean;
  /**
   * Client name sent during MCP protocol negotiation.
   * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
   */
  mcpClientName: string;
  /**
   * Client version sent during MCP protocol negotiation.
   * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
   */
  mcpClientVersion: string;
  /**
   * Sends the user agent to the authorization URL.
   */
  redirect: (url: string) => void;
  /**
   * Persistent storage shared by connection and callback handlers.
   * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
   */
  store: McpClientStore;
}

/**
 * Creates an MCP session that registers its OAuth client during the first
 * connection.
 *
 * @example
 * ```ts
 * const session = await createDynamicallyRegisteredMcpClient({
 *   mcpEndpoint: 'https://api.example.com/mcp',
 *   oauthRedirectUrl: 'https://app.example.com/oauth/callback',
 *   oauthClientName: 'Example MCP Client',
 *   mcpClientName: 'example-client',
 *   mcpClientVersion: '1.0.0',
 *   redirect: url => response.redirect(url),
 *   store,
 * });
 *
 * await session.connect();
 * ```
 */
export async function createDynamicallyRegisteredMcpClient({
  redirect,
  store,
  ...clientParams
}: CreateDynamicallyRegisteredMcpClientParams): Promise<McpClientReturnType> {
  const state = randomUUID();
  const sessionId = randomUUID();

  const client: ClientData = {
    ...clientParams,
  };

  // associate state with session id
  // in the oauth callback, we only have the state, and will need to get the
  // client information, so we need this to resolve the session id
  await store.write(`${STATE_PREFIX}${state}`, sessionId);

  // persist all the client details to the store, we will need them to
  // re-create the client later in the oauth callback and any mcp call endpoints
  await writeClientData(sessionId, store, client);

  const authProvider = createOAuthProvider({ client, sessionId, store, state, redirect });

  return createReturnValue(client, authProvider, sessionId);
}

function createOAuthProvider({
  client,
  sessionId,
  store,
  state: initialState,
  redirect,
}: {
  client: ClientData;
  sessionId: string;
  store: McpClientStore;
  state?: string;
  redirect?: (url: string) => void | Promise<void>;
}): OAuthClientProvider {
  let currentState = initialState;
  let initialStateAvailable = initialState !== undefined;

  const createState = async () => {
    if (initialStateAvailable) {
      initialStateAvailable = false;
      return currentState!;
    }

    currentState = randomUUID();
    await store.write(`${STATE_PREFIX}${currentState}`, sessionId);
    return currentState;
  };

  const requireState = async () => {
    if (currentState) return currentState;
    return createState();
  };

  return {
    redirectUrl: client.oauthRedirectUrl,
    clientMetadata: {
      redirect_uris: [client.oauthRedirectUrl],
      client_name: client.oauthClientName || client.mcpClientName,
      client_uri: client.oauthClientUri,
      scope: client.oauthScopes,
      token_endpoint_auth_method: client.oauthPublicClient ? 'none' : undefined,
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      logo_uri: undefined,
      tos_uri: undefined,
    },
    state: createState,
    clientInformation: async () => {
      const latest = await getClientData(sessionId, store);
      return getStoredClientInformation(latest);
    },
    saveClientInformation: async (clientInformation) => {
      await updateClientData(sessionId, store, (latest) => ({
        ...latest,
        clientId: clientInformation.client_id,
        clientSecret: clientInformation.client_secret,
        oauthClientInformation: clientInformation,
      }));
    },
    tokens: async () => {
      const latest = await getClientData(sessionId, store);
      return getStoredTokens(latest);
    },
    saveTokens: async (tokens) => {
      await updateClientData(sessionId, store, (latest) => ({
        ...latest,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        oauthTokens: tokens,
      }));
    },
    redirectToAuthorization: async (url) => {
      if (!redirect) {
        throw new Error(
          'A redirect function is required when a restored client needs OAuth authorization',
        );
      }
      await redirect(url.toString());
    },
    saveCodeVerifier: async (verifier) => {
      const state = await requireState();
      await store.write(`${CODE_VERIFIER_PREFIX}${state}`, verifier);
    },
    codeVerifier: async () => {
      const state = await requireState();
      const verifier = await store.read(`${CODE_VERIFIER_PREFIX}${state}`);
      if (!verifier || typeof verifier !== 'string') {
        throw new Error(`No code verifier found for state "${state}" in the store`);
      }
      return verifier;
    },
    saveDiscoveryState: async (discoveryState) => {
      await updateClientData(sessionId, store, (latest) => ({
        ...latest,
        oauthDiscoveryState: discoveryState,
      }));
    },
    discoveryState: async () => {
      const latest = await getClientData(sessionId, store);
      return latest.oauthDiscoveryState;
    },
    invalidateCredentials: async (scope) => {
      await updateClientData(sessionId, store, (latest) => ({
        ...latest,
        ...(scope === 'all' || scope === 'client'
          ? {
              clientId: undefined,
              clientSecret: undefined,
              oauthClientInformation: undefined,
            }
          : {}),
        ...(scope === 'all' || scope === 'tokens'
          ? { accessToken: undefined, refreshToken: undefined, oauthTokens: undefined }
          : {}),
        ...(scope === 'all' || scope === 'discovery' ? { oauthDiscoveryState: undefined } : {}),
      }));

      if ((scope === 'all' || scope === 'verifier') && currentState) {
        await store.write(`${CODE_VERIFIER_PREFIX}${currentState}`, null);
      }
    },
  };
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

  const mcpClient = new Client(
    {
      name: client.mcpClientName,
      version: client.mcpClientVersion,
    },
    {
      versionNegotiation: { mode: 'auto' },
    },
  );

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
 * Persisted MCP client session data.
 *
 * `oauthClientInformation`, `oauthTokens`, and `oauthDiscoveryState` preserve
 * the complete SDK values, including issuer bindings. The scalar credential
 * fields remain for sessions written by earlier mcp-tools versions.
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
  oauthClientInformation?: StoredOAuthClientInformation;
  oauthTokens?: StoredOAuthTokens;
  oauthDiscoveryState?: OAuthDiscoveryState;
  authComplete?: boolean;
  oauthClientName?: string;
  oauthClientUri?: string;
  oauthScopes?: string;
  oauthPublicClient?: boolean;
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

function getStoredClientInformation(client: ClientData) {
  if (client.oauthClientInformation) return client.oauthClientInformation;
  if (!client.clientId) return undefined;

  return {
    client_id: client.clientId,
    client_secret: client.clientSecret,
  } satisfies StoredOAuthClientInformation;
}

function getStoredTokens(client: ClientData) {
  if (client.oauthTokens) return client.oauthTokens;
  if (!client.accessToken) return undefined;

  return {
    access_token: client.accessToken,
    refresh_token: client.refreshToken,
    token_type: 'Bearer',
  } satisfies StoredOAuthTokens;
}

async function writeClientData(sessionId: string, store: McpClientStore, client: ClientData) {
  await store.write(`${SESSION_PREFIX}${sessionId}`, client as unknown as JsonSerializable);
}

async function updateClientData(
  sessionId: string,
  store: McpClientStore,
  update: (client: ClientData) => ClientData,
) {
  const latest = await getClientData(sessionId, store);
  await writeClientData(sessionId, store, update(latest));
}
