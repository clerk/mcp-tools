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
  properties?: Record<string, any>;
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
}: {
  publishableKey: string;
  resourceUrl: string;
}) {
  const fapiUrl = deriveFapiUrl(publishableKey);

  return generateProtectedResourceMetadata({
    authServerUrl: fapiUrl,
    resourceUrl,
    properties: {
      service_documentation: "https://clerk.com/docs",
    },
  });
}

function deriveFapiUrl(publishableKey: string) {
  const key = publishableKey.replace(/^pk_(test|live)_/, "");
  const decoded = Buffer.from(key, "base64").toString("utf8");
  return "https://" + decoded.replace(/\$/, "");
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
 * CORS headers for OAuth metadata endpoints
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};
