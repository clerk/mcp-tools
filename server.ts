/**
 * Generates protected resource metadata for the given publishable key and
 * resource origin.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 * @param publishableKey - Clerk publishable key
 * @param origin - Origin of the resource to which the metadata applies
 * @returns Protected resource metadata, serializable to JSON
 */
export function generateProtectedResourceMetadata(
  publishableKey: string,
  origin: string
) {
  const fapiUrl = deriveFapiUrl(publishableKey);

  return {
    resource: origin,
    authorization_servers: [fapiUrl],
    token_types_supported: ["urn:ietf:params:oauth:token-type:access_token"],
    token_introspection_endpoint: `${fapiUrl}/oauth/token`,
    token_introspection_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
    ],
    jwks_uri: `${fapiUrl}/.well-known/jwks.json`,
    service_documentation: "https://clerk.com/docs",
    authorization_data_types_supported: ["oauth_scope"],
    authorization_data_locations_supported: ["header", "body"],
    key_challenges_supported: [
      {
        challenge_type: "urn:ietf:params:oauth:pkce:code_challenge",
        challenge_algs: ["S256"],
      },
    ],
  };
}

function deriveFapiUrl(publishableKey: string) {
  const key = publishableKey.replace(/^pk_(test|live)_/, "");
  const decoded = Buffer.from(key, "base64").toString("utf8");
  return "https://" + decoded.replace(/\$/, "");
}
