// Internal provenance shared by the server entry point and bearer authentication. Not a package export.
import type { AuthInfo } from './mcp-types';

const clerkVerified = new WeakSet<AuthInfo>();

/**
 * Records an auth object created by `toClerkAuthInfo`, without adding any public fields.
 */
export function markClerkVerified<T extends AuthInfo>(authInfo: T): T {
  clerkVerified.add(authInfo);
  return authInfo;
}

/**
 * Whether this exact auth object was created by Clerk conversion or copied by our bearer authenticator.
 */
export function hasClerkVerification(authInfo: AuthInfo): boolean {
  return clerkVerified.has(authInfo);
}

/**
 * Carries provenance across the library's metadata copy, but never promotes an unverified source.
 */
export function copyClerkVerification<T extends AuthInfo>(source: AuthInfo, copy: T): T {
  if (hasClerkVerification(source)) markClerkVerified(copy);
  return copy;
}
