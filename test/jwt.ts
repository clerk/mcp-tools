// Test-only: a JWT-shaped token for code that reads the payload after Clerk verified the signature.
/** A JWT-shaped token; the signature is not checked here, because Clerk checks it before this runs. */
export function jwtWith(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'at+jwt' })}.${encode(payload)}.signature`;
}
