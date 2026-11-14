// The `properties` rule that `generateProtectedResourceMetadata` and every `protectedResourceMetadataHandler` share.
// This module is not a package entry point.

/**
 * Throws a `Clerk error:` message when `properties` has its own `resource` key, even one set to `undefined`. The
 * metadata generator and every `protectedResourceMetadataHandler` share it, so each fails with the same diagnosis.
 * @param caller - The entry point named in the message, such as `generateProtectedResourceMetadata`
 * @param properties - The additional metadata the caller was given
 */
export function assertPropertiesOmitResource(caller: string, properties: object | undefined) {
  // RFC 9728 section 3.3: a client discards metadata whose `resource` is not the URL it derived the metadata URL from
  if (properties !== undefined && Object.hasOwn(properties, 'resource')) {
    throw new Error(
      `Clerk error: ${caller} properties cannot set resource: it must be the resourceUrl the metadata describes (RFC 9728 section 3.3). Pass it as resourceUrl instead, as ${caller}({ resourceUrl: 'https://mcp.example.com/mcp' })`,
    );
  }
}
