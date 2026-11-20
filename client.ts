import { randomUUID } from 'node:crypto';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { JsonSerializable, McpClientStore } from './client-store';

export type { JsonSerializable, McpClientStore } from './client-store';

const CODE_VERIFIER_PREFIX = 'pkce_verifier_';
const STATE_PREFIX = 'state_';
const SESSION_PREFIX = 'session_';

/**
 * This function is used to complete the OAuth flow. It is used in the OAuth
 * callback route to complete the OAuth flow given a state and auth code.
 */
export async function completeOAuth({
  state,
  code,
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
   * A persistent store for auth data
   * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
   */
  store: McpClientStore;
}) {
  const sessionId = await store.read(`${STATE_PREFIX}${state}`);

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error(`No session id associated with state "${state}" found in the store`);
  }

  const { transport } = await getMcpClientBySessionId({
    sessionId,
    store,
    state,
  });

  await transport.finishAuth(code);

  // Read the updated client data AFTER finishAuth (which saves tokens)
  const updatedClientData = await getClientData(sessionId, store);

  // write to the store that the auth is complete
  await store.write(`${SESSION_PREFIX}${sessionId}`, {
    ...updatedClientData,
    authComplete: true,
  });

  return { transport, sessionId };
}

/**
 * Given a client ID and a store, retrieves the client details and returns a
 * transport and MCP client configured with an auth provider.
 */
export async function getMcpClientBySessionId({
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
  let client = await getClientData(sessionId, store);

  const authProvider: OAuthClientProvider = {
    redirectUrl: client.oauthRedirectUrl,
    clientMetadata: {
      redirect_uris: [client.oauthRedirectUrl],
      logo_uri: undefined,
      tos_uri: undefined,
    },
    // Read from the store, so a provider created before another one bound
    // the session presents the bound client information. Only client
    // information bound to an issuer is presented: credentials saved by an
    // earlier version have none, and the SDK would send them, with the
    // authorization code, to whichever authorization server the MCP server
    // names. There is no saveClientInformation: a stored session never
    // registers or rebinds.
    clientInformation: async () => {
      client = await getClientData(sessionId, store);
      const info = getStoredClientInformation(client);
      if (info && !isBound(info)) {
        throw new Error(
          `Session "${sessionId}" has OAuth client credentials that are not bound to an authorization server, so they are not sent to one. Start a new connection with createKnownCredentialsMcpClient or createDynamicallyRegisteredMcpClient.`,
        );
      }
      return info;
    },
    // The callback restores the discovery state saved at redirect, so the code
    // is exchanged with the authorization server that issued it, even when
    // discovery would now name another, as it can when the redirect followed a
    // resource metadata URL from a 401 challenge that the callback does not
    // have. Other resumptions discover afresh, so a change of authorization
    // server still meets the binding check.
    discoveryState: async () => {
      if (!state) return undefined;
      client = await getClientData(sessionId, store);
      return client.oauthDiscoveryState as OAuthDiscoveryState | undefined;
    },
    tokens: () => {
      if (client.oauthTokens) return client.oauthTokens;
      if (!client.accessToken) return undefined;
      // Tokens saved by an earlier version have no issuer, and the SDK would
      // send their refresh token to whichever authorization server the MCP
      // server names, so only the access token is returned.
      return {
        access_token: client.accessToken,
        token_type: 'Bearer',
      };
    },
    saveTokens: async (tokens) => {
      client = await saveClientTokens(sessionId, store, tokens);
    },
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

/**
 * Connection returned by the MCP client factories, with its session, connect function, and underlying SDK objects.
 */
export interface McpClientConnection {
  /**
   * Represents a session associated with the connected MCP service endpoint.
   */
  sessionId: string;
  /**
   * Connects to the MCP service. Resolves once the connection is initialized.
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

/**
 * Options for `createKnownCredentialsMcpClient`, using an existing OAuth client's credentials to connect to an MCP service.
 */
export interface CreateKnownCredentialsMcpClientOptions {
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
}: CreateKnownCredentialsMcpClientOptions): Promise<McpClientConnection> {
  let client: McpClientData = clientParams;
  const state = randomUUID();
  const sessionId = randomUUID();

  // associate state with session id
  // in the oauth callback, we only have the state, and will need to get the
  // client information, so we need this to resolve the session id
  await store.write(`${STATE_PREFIX}${state}`, sessionId);

  // persist all the client details to the store, we will need them to
  // re-create the client later in the oauth callback and any mcp call endpoints
  await store.write(`${SESSION_PREFIX}${sessionId}`, { ...client });

  // Staged when discovery reports the authorization server and saved just
  // before the redirect, so a start that fails before the redirect leaves the
  // session unbound.
  let pendingClientInformation: OAuthClientInformationMixed | undefined;
  let pendingDiscoveryState: OAuthDiscoveryState | undefined;

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
    clientInformation: () => pendingClientInformation ?? getStoredClientInformation(client),
    // The SDK reports the authorization server it discovered before it reads
    // the client information and builds the authorization request. The known
    // credentials are bound to it here, and saved with the discovery state
    // before the redirect, so the code exchange sends the code and client
    // secret to that server only (RFC 9700 section 4.4.2). There is no
    // saveClientInformation: known credentials never register, so another
    // authorization server is rejected once they are bound.
    saveDiscoveryState: async (discoveryState) => {
      pendingDiscoveryState = discoveryState;
      client = await getClientData(sessionId, store);
      if (client.oauthClientInformation && isBound(client.oauthClientInformation)) return;
      pendingClientInformation = {
        client_id: clientParams.clientId,
        client_secret: clientParams.clientSecret,
        issuer: String(discoveryState.authorizationServerUrl),
      };
    },
    // it's impossible that we have an access token at this point, so we always
    // return undefined
    tokens: () => undefined,
    // called in the oauth callback route
    saveTokens: unexpectedFunctionCall('saveTokens', 'initializing a known credentials client'),
    redirectToAuthorization: async (url) => {
      if (pendingClientInformation) {
        client = await saveClientInformation(sessionId, store, pendingClientInformation);
        pendingClientInformation = undefined;
      }
      if (pendingDiscoveryState) {
        client = await saveDiscoveryState(sessionId, store, pendingDiscoveryState);
      }
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

/**
 * Options for `createDynamicallyRegisteredMcpClient`, registering a new OAuth client to connect to an MCP service.
 */
export interface CreateDynamicallyRegisteredMcpClientOptions {
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
}: CreateDynamicallyRegisteredMcpClientOptions): Promise<McpClientConnection> {
  const state = randomUUID();
  const sessionId = randomUUID();

  // this is our in-memory client object, we will update it with the client id
  // and secret after dynamic registration is complete
  let client: McpClientData = { ...clientParams };

  // associate state with session id
  // in the oauth callback, we only have the state, and will need to get the
  // client information, so we need this to resolve the session id
  await store.write(`${STATE_PREFIX}${state}`, sessionId);

  // persist all the client details to the store, we will need them to
  // re-create the client later in the oauth callback and any mcp call endpoints
  await store.write(`${SESSION_PREFIX}${sessionId}`, { ...client });

  // Saved just before the redirect, for the callback to restore.
  let pendingDiscoveryState: OAuthDiscoveryState | undefined;

  const authProvider: OAuthClientProvider = {
    redirectUrl: client.oauthRedirectUrl,
    // this information is used to create an oauth client via dynamic client
    // registration
    clientMetadata: {
      redirect_uris: [client.oauthRedirectUrl],
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
    // Read from the store, so this provider sees a binding saved elsewhere
    // and its saveClientInformation getter below is absent accordingly.
    clientInformation: async () => {
      client = await getClientData(sessionId, store);
      return getStoredClientInformation(client);
    },
    // this is called after a new oauth client is created, so we now have a
    // client id and secret. It is absent once that registration is bound to
    // an issuer, so a later authorization against another server is rejected
    // instead of registering there and overwriting the stored client.
    get saveClientInformation() {
      if (client.oauthClientInformation?.issuer) return undefined;
      return async (newInfo: OAuthClientInformationMixed) => {
        client = await saveClientInformation(sessionId, store, newInfo);
      };
    },
    // it's impossible that we have an access token at this point, so we always
    // return undefined
    tokens: () => undefined,
    // called in the oauth callback route
    saveTokens: async (tokens) => {
      client = await saveClientTokens(sessionId, store, tokens);
    },
    saveDiscoveryState: (discoveryState) => {
      pendingDiscoveryState = discoveryState;
    },
    redirectToAuthorization: async (url) => {
      if (pendingDiscoveryState) {
        client = await saveDiscoveryState(sessionId, store, pendingDiscoveryState);
      }
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
  client: McpClientData,
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
export interface McpClientData {
  oauthRedirectUrl: string;
  mcpEndpoint: string;
  mcpClientName: string;
  mcpClientVersion: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  /**
   * Complete SDK client information, including its authorization server issuer.
   */
  oauthClientInformation?: OAuthClientInformationMixed;
  /**
   * Complete SDK tokens, including their authorization server issuer.
   */
  oauthTokens?: OAuthTokens;
  /**
   * SDK `OAuthDiscoveryState` saved at the redirect, restored by the OAuth
   * callback and dropped once tokens are saved.
   */
  oauthDiscoveryState?: JsonSerializable;
  authComplete?: boolean;
  oauthClientName?: string;
  oauthClientUri?: string;
  oauthScopes?: string;
  oauthPublicClient?: boolean;
}

function getStoredClientInformation(
  client: McpClientData,
): OAuthClientInformationMixed | undefined {
  if (client.oauthClientInformation) return client.oauthClientInformation;
  if (!client.clientId) return undefined;
  return { client_id: client.clientId, client_secret: client.clientSecret };
}

function isBound(value: { issuer?: string }): value is { issuer: string } {
  return typeof value.issuer === 'string';
}

/**
 * Compares issuers the way the SDK does: as parsed URLs when both parse, so
 * the spelling of scheme, host or default port does not matter, and ignoring
 * a trailing slash.
 */
function issuersMatch(a: string, b: string) {
  const [x, y] = canParseUrl(a) && canParseUrl(b) ? [new URL(a).href, new URL(b).href] : [a, b];
  return (
    x === y ||
    (x.endsWith('/') && x.slice(0, -1) === y) ||
    (y.endsWith('/') && y.slice(0, -1) === x)
  );
}

function canParseUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throws when the stored session holds a value bound to an issuer other than
 * the incoming one, so a provider holding an outdated copy of the session
 * cannot replace a binding another provider saved.
 */
function assertSameIssuer(
  sessionId: string,
  stored: { issuer?: string } | undefined,
  incoming: { issuer?: string },
  name: string,
) {
  if (!stored || !isBound(stored)) return;
  if (isBound(incoming) && issuersMatch(stored.issuer, incoming.issuer)) return;
  throw new Error(
    `Session "${sessionId}" is bound to authorization server ${stored.issuer} and does not save ${name} for ${incoming.issuer ?? 'no authorization server'}.`,
  );
}

async function saveClientInformation(
  sessionId: string,
  store: McpClientStore,
  clientInformation: OAuthClientInformationMixed,
): Promise<McpClientData> {
  const stored = await getClientData(sessionId, store);
  assertSameIssuer(
    sessionId,
    stored.oauthClientInformation,
    clientInformation,
    'client information',
  );
  const client = {
    ...stored,
    clientId: clientInformation.client_id,
    clientSecret: clientInformation.client_secret,
    oauthClientInformation: clientInformation,
  };
  await store.write(`${SESSION_PREFIX}${sessionId}`, client);
  return client;
}

async function saveDiscoveryState(
  sessionId: string,
  store: McpClientStore,
  discoveryState: OAuthDiscoveryState,
): Promise<McpClientData> {
  const stored = await getClientData(sessionId, store);
  // The SDK's metadata types allow unknown members, which parsed JSON holds.
  const client = { ...stored, oauthDiscoveryState: discoveryState as unknown as JsonSerializable };
  await store.write(`${SESSION_PREFIX}${sessionId}`, client);
  return client;
}

async function saveClientTokens(
  sessionId: string,
  store: McpClientStore,
  tokens: OAuthTokens,
): Promise<McpClientData> {
  const { oauthDiscoveryState: _, ...stored } = await getClientData(sessionId, store);
  assertSameIssuer(sessionId, stored.oauthClientInformation, tokens, 'tokens');
  assertSameIssuer(sessionId, stored.oauthTokens, tokens, 'tokens');
  // The discovery state served the callback that obtained these tokens, so it
  // is dropped and later authorizations discover afresh.
  const client = {
    ...stored,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    oauthTokens: tokens,
  };
  await store.write(`${SESSION_PREFIX}${sessionId}`, client);
  return client;
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

  return clientData as unknown as McpClientData;
}
