// Test-only: stands in for Clerk's JWKS endpoint, and signs the OAuth access tokens that `@clerk/backend` then verifies
// for real, including the `aud` claim. Nothing is mocked inside the Clerk packages.
import { createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const KID = 'ins_test_kid';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk: JsonWebKey = {
  ...publicKey.export({ format: 'jwk' }),
  kid: KID,
  alg: 'RS256',
  use: 'sig',
};

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export type TokenClaims = {
  aud: string | string[];
  scopes: readonly string[];
  userId?: string;
  clientId?: string;
};

/** A signed OAuth access token (`at+jwt`) that carries the claims Clerk puts in its own. */
export function signAccessToken({
  aud,
  scopes,
  userId = 'user_1',
  clientId = 'client_1',
}: TokenClaims) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: KID }));
  const payload = b64url(
    JSON.stringify({
      iss: 'https://clerk.example.com',
      sub: userId,
      aud,
      client_id: clientId,
      scope: scopes.join(' '),
      jti: `jti_${Math.random().toString(36).slice(2)}`,
      iat: now,
      nbf: now - 5,
      exp: now + 600,
    }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

let started: Promise<void> | undefined;

/**
 * Starts the JWKS endpoint once per test file and points the Clerk packages at it through the environment they read.
 * The Express adapter builds its Clerk client on first use and keeps it, so the endpoint stays up until the process ends.
 */
export function useFakeClerk(): Promise<void> {
  started ??= new Promise((resolve) => {
    const server = createServer((req, res) => {
      const found = req.url?.startsWith('/v1/jwks') ?? false;
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(found ? JSON.stringify({ keys: [jwk] }) : '{}');
    });
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      process.env.CLERK_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.CLERK_SECRET_KEY = 'sk_test_fake_clerk_for_tests';
      process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
      resolve();
    });
  });
  return started;
}
