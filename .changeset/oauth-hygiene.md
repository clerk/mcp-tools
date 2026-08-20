---
'@clerk/mcp-tools': minor
---

OAuth hygiene: CIMD, RFC 9207 `iss` on error responses, issuer-keyed credentials, `application_type` for mixed redirect sets, and Origin validation.

**New:**

- `createDynamicallyRegisteredMcpClient` accepts `oauthClientMetadataUrl`: when the authorization server supports Client ID Metadata Documents (CIMD), the URL is used directly as the `client_id` and dynamic client registration is skipped. The URL is validated eagerly (HTTPS, non-root path).
- `createDynamicallyRegisteredMcpClient` accepts `oauthAdditionalRedirectUrls` for registrations needing more than one redirect URL. When the combined set mixes web and native-class (custom-scheme or loopback) URLs, `application_type: 'native'` is set explicitly in the DCR request — the derivation is ambiguous for mixed sets.
- `validateAuthorizationResponseIss` (from `@clerk/mcp-tools/client`) validates the `iss` of an authorization **error** response against the issuer recorded before the redirect (RFC 9207). The Next.js `completeOAuthHandler` now handles `?error=...` callbacks: the error is surfaced with a 400 only after its `iss` validates; on a mismatch a generic `invalid_authorization_response` is returned that echoes nothing from the callback.
- The Express, Hono, and Next.js `streamableHttpHandler` validate the `Origin` header, as the MCP spec requires: requests carrying an `Origin` whose hostname is neither localhost-class (`localhost`, `127.0.0.1`, `[::1]`) nor listed in the new `allowedOrigins` option are rejected with a `403` (DNS rebinding / CSRF defense). The allowlist is never derived from the request's own `Host` header — in a DNS rebinding attack the attacker controls both `Origin` and `Host`. Non-browser MCP clients send no `Origin` and are unaffected; browser clients on any non-localhost origin need `allowedOrigins`.

**Fixed:**

- Persisted OAuth credentials and tokens are now keyed by authorization-server issuer (SEP-2352): the providers round-trip the SDK's `issuer` stamp and persist discovery state across the redirect round-trip, so credentials registered with one AS are never replayed against a different one, an AS change triggers re-registration, and tokens from the previous AS are dropped when it happens. Previously the stamp was silently discarded, disabling the SDK's mix-up defense.
- The known-credentials flow (`createKnownCredentialsMcpClient`) was broken since the v2 migration: the SDK back-stamps the issuer via `saveClientInformation`, which was defined as a throwing stub.
- Re-registration through a `getClientBySessionId` provider no longer corrupts the stored session (it previously persisted wire-format `client_id`/`client_secret` keys that could never be read back).
