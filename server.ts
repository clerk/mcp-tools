import type { MachineAuthObject } from '@clerk/backend';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';

/** Minimum Clerk OAuth access token shape required by the MCP verifier. */
export interface ClerkOAuthAccessToken {
  clientId: string;
  subject: string;
  scopes: string[];
  revoked: boolean;
  expired: boolean;
  expiration: number | null;
}

/** Structural subset of Clerk's OAuth access token API. */
export interface ClerkOAuthAccessTokenClient {
  verify(accessToken: string): Promise<ClerkOAuthAccessToken>;
}

/** Structural subset of a Clerk client that exposes OAuth access token verification. */
export interface ClerkClientWithOAuthAccessTokens {
  idPOAuthAccessToken: ClerkOAuthAccessTokenClient;
}

/** A full Clerk client or its OAuth access token API. */
export type ClerkOAuthTokenVerifierSource =
  | ClerkOAuthAccessTokenClient
  | ClerkClientWithOAuthAccessTokens;

/**
 * Creates an MCP v2 token verifier backed by Clerk's OAuth access token API.
 *
 * The verifier supplies the expiration that the MCP SDK bearer-auth gate requires.
 * Confirmed invalid tokens become OAuth `invalid_token` errors. Service and
 * configuration failures remain server errors.
 *
 * @param source - A Clerk client or its `idPOAuthAccessToken` API
 * @returns A verifier for `requireBearerAuth`
 *
 * @example
 * ```ts
 * import { createClerkClient } from '@clerk/backend';
 * import { requireBearerAuth } from '@modelcontextprotocol/server';
 * import { createClerkOAuthTokenVerifier } from '@clerk/mcp-tools/server';
 *
 * const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
 * const requireAuth = requireBearerAuth({
 *   verifier: createClerkOAuthTokenVerifier(clerk),
 *   requiredScopes: ['mcp:read'],
 * });
 * ```
 */
export function createClerkOAuthTokenVerifier(
  source: ClerkOAuthTokenVerifierSource,
): OAuthTokenVerifier {
  const accessTokenClient =
    (source as Partial<ClerkClientWithOAuthAccessTokens>).idPOAuthAccessToken ??
    (source as ClerkOAuthAccessTokenClient);

  return {
    async verifyAccessToken(token) {
      let clerkToken: ClerkOAuthAccessToken;

      try {
        clerkToken = await accessTokenClient.verify(token);
      } catch (error) {
        if (isClerkTokenNotFoundError(error)) {
          throw invalidTokenError();
        }

        throw error;
      }

      if (clerkToken.revoked || clerkToken.expired || clerkToken.expiration === null) {
        throw invalidTokenError();
      }

      return {
        token,
        clientId: clerkToken.clientId,
        scopes: clerkToken.scopes,
        expiresAt: Math.floor(clerkToken.expiration / 1000),
        extra: { userId: clerkToken.subject },
      };
    },
  };
}

function invalidTokenError() {
  return new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid OAuth access token');
}

function isClerkTokenNotFoundError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'clerkError' in error &&
    error.clerkError === true &&
    'status' in error &&
    error.status === 404
  );
}

/**
 * Generates RFC 9728 Protected Resource Metadata for an MCP resource.
 *
 * Custom properties can add fields such as `scopes_supported` or override a
 * generated default.
 *
 * @param authServerUrl - Authorization server URL
 * @param resourceUrl - Full MCP resource URL, including its path
 * @param properties - Additional metadata properties
 * @returns Protected resource metadata, serializable to JSON
 *
 * @example
 * ```ts
 * const metadata = generateProtectedResourceMetadata({
 *   authServerUrl: 'https://auth.example.com',
 *   resourceUrl: 'https://api.example.com/mcp',
 *   properties: { scopes_supported: ['mcp:read'] },
 * });
 * ```
 */
export function generateProtectedResourceMetadata({
  authServerUrl,
  resourceUrl,
  properties,
}: {
  authServerUrl: string;
  resourceUrl: string;
  properties?: Record<string, unknown>;
}) {
  return Object.assign(
    {
      resource: resourceUrl,
      authorization_servers: [authServerUrl],
      token_types_supported: ['urn:ietf:params:oauth:token-type:access_token'],
      token_introspection_endpoint: `${authServerUrl}/oauth/token`,
      token_introspection_endpoint_auth_methods_supported: [
        'client_secret_post',
        'client_secret_basic',
      ],
      jwks_uri: `${authServerUrl}/.well-known/jwks.json`,
      authorization_data_types_supported: ['oauth_scope'],
      authorization_data_locations_supported: ['header', 'body'],
      key_challenges_supported: [
        {
          challenge_type: 'urn:ietf:params:oauth:pkce:code_challenge',
          challenge_algs: ['S256'],
        },
      ],
    },
    properties,
  );
}

/**
 * Generates Clerk Protected Resource Metadata without making a network request.
 *
 * The Clerk authorization server URL is derived from the publishable key.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 * @param publishableKey - Clerk publishable key
 * @param resourceUrl - Full MCP resource URL, including its path
 * @param properties - Additional metadata properties
 * @returns Protected resource metadata, serializable to JSON
 *
 * @example
 * ```ts
 * const metadata = generateClerkProtectedResourceMetadata({
 *   publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
 *   resourceUrl: 'https://api.example.com/mcp',
 *   properties: { scopes_supported: ['mcp:read'] },
 * });
 * ```
 */
export function generateClerkProtectedResourceMetadata({
  publishableKey,
  resourceUrl,
  properties,
}: {
  publishableKey: string;
  resourceUrl: string;
  properties?: Record<string, unknown>;
}) {
  const fapiUrl = deriveFapiUrl(publishableKey);

  return generateProtectedResourceMetadata({
    authServerUrl: fapiUrl,
    resourceUrl,
    properties: {
      service_documentation: 'https://clerk.com/docs',
      ...properties,
    },
  });
}

function deriveFapiUrl(publishableKey: string) {
  const key = publishableKey.replace(/^pk_(test|live)_/, '');
  const normalizedKey = key.replace(/-/g, '+').replace(/_/g, '/');
  const paddedKey = normalizedKey.padEnd(Math.ceil(normalizedKey.length / 4) * 4, '=');
  const decoded = atob(paddedKey);
  return `https://${decoded.replace(/\$/, '')}`;
}

/**
 * Fetches Clerk's OAuth Authorization Server Metadata for a publishable key.
 *
 * @param publishableKey - Clerk publishable key
 * @returns The JSON response from Clerk's discovery endpoint
 *
 * @example
 * ```ts
 * const metadata = await fetchClerkAuthorizationServerMetadata({
 *   publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
 * });
 * ```
 */
export async function fetchClerkAuthorizationServerMetadata({
  publishableKey,
}: {
  publishableKey: string;
}) {
  const fapiUrl = deriveFapiUrl(publishableKey);

  return fetch(`${fapiUrl}/.well-known/oauth-authorization-server`)
    .then((res) => res.json())
    .then((metadata) => {
      return metadata;
    });
}

/**
 * Converts an authenticated Clerk middleware result to MCP `AuthInfo`.
 *
 * This compatibility helper does not supply `expiresAt`, because Clerk's
 * middleware auth object does not include token expiration. MCP v2 bearer
 * authentication rejects its result. Use `createClerkOAuthTokenVerifier` for
 * new servers.
 *
 * @param auth - The auth object returned from the Clerk auth() function called with acceptsToken: 'oauth_token'
 * @param token - The token to verify
 * @deprecated Use createClerkOAuthTokenVerifier with SDK bearer authentication.
 * @returns MCP AuthInfo, or `undefined` when authentication fails
 */
export function verifyClerkToken(
  auth: MachineAuthObject<'oauth_token'>,
  token: string | undefined,
): AuthInfo | undefined {
  if (!token) return undefined;

  if (!auth.isAuthenticated) {
    console.error('Invalid OAuth access token');
    return undefined;
  }

  if (auth.tokenType !== 'oauth_token') {
    throw new Error("the auth() function must be called with acceptsToken: 'oauth_token'");
  }

  // None of these _should_ ever happen
  if (!auth.clientId) {
    console.error('Clerk error: No clientId returned from auth()');
    return undefined;
  }

  if (!auth.scopes) {
    console.error('Clerk error: No scopes returned from auth()');
    return undefined;
  }

  if (!auth.userId) {
    console.error('Clerk error: No userId returned from auth()');
    return undefined;
  }

  return {
    token,
    scopes: auth.scopes,
    clientId: auth.clientId,
    extra: { userId: auth.userId },
  };
}

/**
 * Permissive CORS headers for public OAuth discovery metadata endpoints.
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};
