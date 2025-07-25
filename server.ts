import type { MachineAuthObject } from "@clerk/backend";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Generates protected resource metadata for the given auth server url and
 * resource server url.
 *
 * @param authServerUrl - URL of the auth server
 * @param resourceServerUrl - URL of the resource server
 * @param properties - Additional properties to include in the metadata
 * @returns Protected resource metadata, serializable to JSON
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
      token_types_supported: ["urn:ietf:params:oauth:token-type:access_token"],
      token_introspection_endpoint: `${authServerUrl}/oauth/token`,
      token_introspection_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
      ],
      jwks_uri: `${authServerUrl}/.well-known/jwks.json`,
      authorization_data_types_supported: ["oauth_scope"],
      authorization_data_locations_supported: ["header", "body"],
      key_challenges_supported: [
        {
          challenge_type: "urn:ietf:params:oauth:pkce:code_challenge",
          challenge_algs: ["S256"],
        },
      ],
    },
    properties
  );
}

/**
 * Generates protected resource metadata for the given a Clerkpublishable key
 * and resource origin.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 * @param publishableKey - Clerk publishable key
 * @param origin - Origin of the resource to which the metadata applies
 * @returns Protected resource metadata, serializable to JSON
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
      service_documentation: "https://clerk.com/docs",
      ...properties,
    },
  });
}

function deriveFapiUrl(publishableKey: string) {
  const key = publishableKey.replace(/^pk_(test|live)_/, "");
  const decoded = Buffer.from(key, "base64").toString("utf8");
  return `https://${decoded.replace(/\$/, "")}`;
}

export function fetchClerkAuthorizationServerMetadata({
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
 * Verifies a Clerk token and returns data in the format expected to be passed
 * as `authData to the MCP SDK.
 * @param auth - The auth object returned from the Clerk auth() function called with acceptsToken: 'oauth_token'
 * @param token - The token to verify
 * @returns AuthInfo type, see `import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";`
 */
export function verifyClerkToken(
  auth: MachineAuthObject<"oauth_token">,
  token: string | undefined
): AuthInfo | undefined {
  if (!token) return undefined;

  if (!auth.isAuthenticated) {
    console.error("Invalid OAuth access token");
    return undefined;
  }

  if (auth.tokenType !== "oauth_token") {
    throw new Error(
      "the auth() function must be called with acceptsToken: 'oauth_token'"
    );
  }

  // None of these _should_ ever happen
  if (!auth.clientId) {
    console.error("Clerk error: No clientId returned from auth()");
    return undefined;
  }

  if (!auth.scopes) {
    console.error("Clerk error: No scopes returned from auth()");
    return undefined;
  }

  if (!auth.userId) {
    console.error("Clerk error: No userId returned from auth()");
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
 * CORS headers for OAuth metadata endpoints
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};
