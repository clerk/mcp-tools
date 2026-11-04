// Internal: the options of `createMcpAuthClerk`, shared by the Express and Hono adapters. Not a package entry point.
import { parseAllowedUrl } from './backend-api';
import type { ClerkAuthInfo } from './server';

export type McpAuthClerkOptions = {
  /**
   * The resource URL of your MCP server, as in the `resource` of its protected resource metadata. MCP clients send it
   * when they request a token and Clerk puts it in the token's `aud` claim. A token for another audience is refused with
   * `401`. Pass an array to accept more than one.
   */
  audience: string | string[];
  /**
   * The protected resource metadata URL that the auth info carries, for the MCP SDK's step-up challenge. Defaults to the
   * URL that the `401` response advertises, which is built from the request. Set it when a proxy changes the host or protocol.
   */
  resourceMetadataUrl?: string;
};

/** Throws a `Clerk error:` message when the options cannot work, and returns a copy that later changes cannot affect. */
export function resolveMcpAuthClerkOptions(options: McpAuthClerkOptions): {
  audience: string | string[];
  resourceMetadataUrl: string | undefined;
} {
  const { audience, resourceMetadataUrl } = options ?? {};
  const audiences = typeof audience === 'string' ? [audience] : audience;
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    !audiences.every((value) => typeof value === 'string' && value.trim() !== '')
  ) {
    throw new Error(
      'Clerk error: createMcpAuthClerk audience must be your MCP server resource URL, a non-empty string, or a non-empty array of them',
    );
  }
  if (
    resourceMetadataUrl !== undefined &&
    (typeof resourceMetadataUrl !== 'string' || !parseAllowedUrl(resourceMetadataUrl))
  ) {
    throw new Error(
      'Clerk error: createMcpAuthClerk resourceMetadataUrl must be a URL that uses HTTPS or loopback HTTP',
    );
  }
  return {
    audience: typeof audience === 'string' ? audience : [...audiences],
    resourceMetadataUrl,
  };
}

/** `authInfo` with the metadata URL the MCP SDK puts in its step-up challenge. */
export function withResourceMetadataUrl(
  authInfo: ClerkAuthInfo,
  resourceMetadataUrl: string,
): ClerkAuthInfo {
  return { ...authInfo, resourceMetadataUrl };
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

/**
 * Whether `token` may be used for `audience`, checked here as well as by Clerk because Clerk SDK versions before the
 * audience fix ignore the option. Call it only after Clerk verified `token`: a JWT's payload is read, not re-verified.
 * A JWT needs an `aud` that is a non-empty string, or an array of them, that overlaps `audience`. A token that is not
 * a JWT (opaque) has no `aud` to read here, so only Clerk's own check covers it.
 */
export function tokenMatchesAudience(token: string, audience: string | string[]): boolean {
  const segments = token.split('.');
  if (segments.length !== 3) return true;
  let aud: unknown;
  try {
    aud = (JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as { aud?: unknown })
      .aud;
  } catch {
    return false;
  }
  const claimed = Array.isArray(aud) ? aud : [aud];
  if (claimed.length === 0 || !claimed.every(isNonEmptyString)) return false;
  const accepted = typeof audience === 'string' ? [audience] : audience;
  return claimed.some((value) => accepted.includes(value));
}
