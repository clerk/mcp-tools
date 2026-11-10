// Runs `verifyClerkOAuthToken` against the real `@clerk/backend` verifier. With a `jwtKey`, Clerk checks a JWT access
// token locally, so these tests need no network.
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createClerkClient } from '@clerk/backend';
import { describe, expect, test } from 'vitest';

import { verifyClerkOAuthToken } from './bearer-auth';
import { McpTokenVerificationError } from './server';

const resourceUrl = 'https://mcp.example.com/mcp';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const clerkClient = createClerkClient({
  secretKey: 'sk_test_clerk_verification',
  publishableKey: 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k',
  jwtKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
});

function accessToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = [
    encode({ alg: 'RS256', typ: 'at+jwt', kid: 'ins_test' }),
    encode({
      iss: 'https://clerk.example.com',
      sub: 'user_123',
      client_id: 'client_123',
      scope: 'profile email',
      jti: 'oat_123',
      iat: now - 10,
      nbf: now - 10,
      exp: now + 300,
      ...claims,
    }),
  ].join('.');
  const signature = createSign('RSA-SHA256').update(signed).sign(privateKey, 'base64url');
  return `${signed}.${signature}`;
}

describe('verifyClerkOAuthToken with real Clerk verification', () => {
  test.each([
    ['its audience is the resource URL', resourceUrl],
    ['its audience list includes the resource URL', ['https://other.example.com', resourceUrl]],
  ])('accepts a token when %s', async (_name, aud) => {
    const token = accessToken({ aud });

    const authInfo = await verifyClerkOAuthToken(clerkClient, token, resourceUrl);

    expect(authInfo).toEqual({
      token,
      clientId: 'client_123',
      scopes: ['profile', 'email'],
      extra: { userId: 'user_123', verifiedBy: 'clerk' },
    });
  });

  test('accepts the normalized form of a resource URL that is not written that way', async () => {
    const token = accessToken({ aud: 'https://mcp.example.com/' });

    const authInfo = await verifyClerkOAuthToken(clerkClient, token, 'https://mcp.example.com');

    expect(authInfo).toMatchObject({ clientId: 'client_123' });
  });

  test.each([
    ['another resource', { aud: 'https://other.example.com/mcp' }, /audience/i],
    ['the bare origin', { aud: 'https://mcp.example.com' }, /audience/i],
    ['a trailing slash the resource URL does not have', { aud: `${resourceUrl}/` }, /audience/i],
    ['no audience', {}, /audience/i],
    [
      'an expiry in the past',
      { aud: resourceUrl, exp: Math.floor(Date.now() / 1000) - 60 },
      /expired/i,
    ],
  ])('rejects a token with %s, with what Clerk reported', async (_name, claims, message) => {
    const error = await verifyClerkOAuthToken(clerkClient, accessToken(claims), resourceUrl).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(McpTokenVerificationError);
    expect(error).toMatchObject({ code: 'token-verification-failed' });
    expect((error as McpTokenVerificationError).message).toMatch(message);
  });

  test('rejects a token signed with another key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const [header, payload] = accessToken({ aud: resourceUrl }).split('.');
    const forged = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(other.privateKey, 'base64url');

    const error = await verifyClerkOAuthToken(
      clerkClient,
      `${header}.${payload}.${forged}`,
      resourceUrl,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(McpTokenVerificationError);
    expect(error).toMatchObject({ code: 'token-verification-failed' });
  });
});
