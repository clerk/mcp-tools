import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const CODE_VERIFIER_PREFIX = "pkce_verifier_";
const STATE_PREFIX = "state_";
const SESSION_PREFIX = "session_";

export interface McpClientStore {
  write: (key: string, value: any) => void;
  read: (key: string) => any;
}

/**
 * This function is used to complete the OAuth flow. It is used in the OAuth
 * callback route to complete the OAuth flow given a state and auth code.
 */
export async function completeAuthWithCode({
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
  const sessionId = store.read(`${STATE_PREFIX}${state}`);

  if (!sessionId) {
    throw new Error(
      `No session id associated with state "${state}" found in the store`
    );
  }

  const { transport } = getClientBySessionId({ sessionId, store, state });

  await transport.finishAuth(code);

  return { transport, sessionId };
}

/**
 * Given a client ID and a store, retrieves the client details and returns a
 * transport and MCP client configured with an auth provider.
 */
export function getClientBySessionId({
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
  const client = store.read(`${SESSION_PREFIX}${sessionId}`);

  if (!client) {
    throw new Error(`Session with ID "${sessionId}" not found in store`);
  }

  // should abstract anything that is repeated here probably
  const authProvider: OAuthClientProvider = {
    redirectUrl: client.oauthRedirectUrl,
    clientMetadata: {
      redirect_uris: [client.oauthRedirectUrl],
    },
    clientInformation: () => ({
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
    saveClientInformation: (newInfo: OAuthClientInformationFull) => {
      store.write(`${SESSION_PREFIX}${sessionId}`, {
        ...client,
        ...newInfo,
      });
    },
    tokens: () => {
      if (!client.accessToken) return undefined;
      return { access_token: client.accessToken, token_type: "Bearer" };
    },
    saveTokens: ({ access_token, refresh_token }) => {
      store.write(`${SESSION_PREFIX}${sessionId}`, {
        ...client,
        accessToken: access_token,
        refreshToken: refresh_token,
      });
    },
    redirectToAuthorization: unexpectedFunctionCall(
      "redirectToAuthorization",
      "getting an existing client"
    ),
    saveCodeVerifier: unexpectedFunctionCall(
      "saveCodeVerifier",
      "getting an existing client"
    ),
    codeVerifier: () => {
      if (!state) {
        throw new Error(
          "The state argument is required to retrieve a code verifier for an already intitialized client"
        );
      }

      const storedVerifier = store.read(`${CODE_VERIFIER_PREFIX}${state}`);

      if (!storedVerifier) {
        throw new Error(
          `No code verifier found for state "${state}" in the store`
        );
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

interface CreateKnownCredentialsMcpClientParams {
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
export function createKnownCredentialsMcpClient({
  redirect,
  store,
  ...client
}: CreateKnownCredentialsMcpClientParams): McpClientReturnType {
  const state = randomUUID();
  const sessionId = randomUUID();

  // associate state with session id
  // in the oauth callback, we only have the state, and will need to get the
  // client information, so we need this to resolve the session id
  store.write(`${STATE_PREFIX}${state}`, sessionId);

  // persist all the client details to the store, we will need them to
  // re-create the client later in the oauth callback and any mcp call endpoints
  store.write(`${SESSION_PREFIX}${sessionId}`, client);

  // there's some non-dry code between this and the dynamically registered
  // client, but this is on purpose for flexibility and clarity.
  const authProvider: OAuthClientProvider = {
    redirectUrl: client.oauthRedirectUrl,
    clientMetadata: {
      redirect_uris: [client.oauthRedirectUrl],
      scope: client.oauthScopes,
    },
    state: () => state,
    clientInformation: () => ({
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
    // only should be used for dynamic client registration
    saveClientInformation: unexpectedFunctionCall(
      "saveClientInformation",
      "initializing a known credentials client"
    ),
    // it's impossible that we have an access token at this point, so we always
    // return undefined
    tokens: () => undefined,
    // called in the oauth callback route
    saveTokens: unexpectedFunctionCall(
      "saveTokens",
      "initializing a known credentials client"
    ),
    redirectToAuthorization: (url) => {
      redirect(url.toString());
    },
    saveCodeVerifier: (verifier: string) => {
      store.write(`${CODE_VERIFIER_PREFIX}${state}`, verifier);
    },
    // called in the oauth callback route
    codeVerifier: unexpectedFunctionCall(
      "codeVerifier",
      "initializing a known credentials client"
    ),
  };

  return createReturnValue(client, authProvider, sessionId);
}

interface CreateDynamicallyRegisteredMcpClientParams {
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

interface DynamicallyRegisteredClient
  extends Omit<
    CreateDynamicallyRegisteredMcpClientParams,
    "store" | "redirect"
  > {
  clientId?: string;
  clientSecret?: string;
}

/**
 * Creates a new MCP client and transport for the first time that is assumed
 * to need to be dynamically registered with an authorization server.
 */
export function createDynamicallyRegisteredMcpClient({
  redirect,
  store,
  ...clientParams
}: CreateDynamicallyRegisteredMcpClientParams): McpClientReturnType {
  const state = randomUUID();
  const sessionId = randomUUID();

  // this is our in-memory client object, we will update it with the client id
  // and secret after dynamic registration is complete
  let client = {
    ...clientParams,
    clientId: undefined as string | undefined,
    clientSecret: undefined as string | undefined,
  };

  // associate state with session id
  // in the oauth callback, we only have the state, and will need to get the
  // client information, so we need this to resolve the session id
  store.write(`${STATE_PREFIX}${state}`, sessionId);

  // persist all the client details to the store, we will need them to
  // re-create the client later in the oauth callback and any mcp call endpoints
  store.write(`${SESSION_PREFIX}${sessionId}`, client);

  const authProvider: OAuthClientProvider = {
    redirectUrl: client.oauthRedirectUrl,
    // this information is used to create an oauth client via dynamic client
    // registration
    clientMetadata: {
      redirect_uris: [client.oauthRedirectUrl],
      client_name: client.oauthClientName || client.mcpClientName,
      client_uri: client.oauthClientUri,
      scope: client.oauthScopes,
      token_endpoint_auth_method: client.oauthPublicClient ? "none" : undefined,
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
      };
    },
    // this is called after a new oauth client is created, so we now have a
    // client id and secret
    saveClientInformation: (newInfo: OAuthClientInformationFull) => {
      const newClientInfo = {
        clientId: newInfo.client_id,
        clientSecret: newInfo.client_secret,
      };

      // update the in-memory client object with the new client id and secret
      client = { ...client, ...newClientInfo };

      // persist the updated client object to the store
      store.write(`${SESSION_PREFIX}${sessionId}`, client);
    },
    // it's impossible that we have an access token at this point, so we always
    // return undefined
    tokens: () => undefined,
    // called in the oauth callback route
    saveTokens: unexpectedFunctionCall(
      "saveTokens",
      "initializing a dynamically registered client"
    ),
    redirectToAuthorization: (url) => {
      redirect(url.toString());
    },
    // since the code verifier is saved before the client is registered, we
    // store it using the state as the key
    saveCodeVerifier: (verifier: string) => {
      store.write(`${CODE_VERIFIER_PREFIX}${state}`, verifier);
    },
    // called in the oauth callback route
    codeVerifier: unexpectedFunctionCall(
      "codeVerifier",
      "initializing a dynamically registered client"
    ),
  };

  return createReturnValue(client, authProvider, sessionId);
}

/**
 * Both known credentials and dynamically registered clients return the same
 * values, so we abstract the common code here.
 */
function createReturnValue(
  client:
    | DynamicallyRegisteredClient
    | Omit<CreateKnownCredentialsMcpClientParams, "store" | "redirect">,
  authProvider: OAuthClientProvider,
  sessionId: string
) {
  const transport = new StreamableHTTPClientTransport(
    new URL(client.mcpEndpoint),
    { authProvider }
  );

  const mcpClient = new Client({
    name: client.mcpClientName,
    version: client.mcpClientVersion,
  });

  return {
    sessionId,
    connect: _connect.bind(null, mcpClient, transport),
    transport,
    client: mcpClient,
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
    throw new Error(
      `Unexpected call to AuthProvider method "${name}" when ${phase}.`
    );
  };
}
