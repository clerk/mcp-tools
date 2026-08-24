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

/**
 * Given a client ID and a store, retrieves the client details and returns a
 * transport and MCP client configured with an auth provider.
 */
export async function getClientBySessionId({
  sessionId,
  store,
  state,
  redirect,
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
  /**
   * Redirects a restored session when OAuth needs a new authorization grant.
   */
  redirect?: (url: string) => void | Promise<void>;
}) {
  const client = await getClientData(sessionId, store);
  const authProvider = createOAuthProvider({ client, sessionId, store, state, redirect });

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
  connect: () => Promise<void>;
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
   * The name of the OAuth client to be created with the authorization server
   */
  oauthClientName?: string;
  /**
   * The URI of the OAuth client to be created with the authorization server
   */
  oauthClientUri?: string;
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
