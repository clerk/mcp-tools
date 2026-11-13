// Runs `verifyClerkOAuthToken` against the real `@clerk/backend` verifier. With a `jwtKey`, Clerk checks a JWT access
// token locally, and the other tests answer Clerk from a local stub, so these tests need no network.
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClerkClient } from '@clerk/backend';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { authenticateBearer, serverErrorAnswer, verifyClerkOAuthToken } from './bearer-auth';
import { McpAuthError, McpTokenVerificationError } from './server';

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
      extra: {
        userId: 'user_123',
        verifiedBy: 'clerk',
        auth: expect.objectContaining({
          isAuthenticated: true,
          tokenType: 'oauth_token',
          id: 'oat_123',
          subject: 'user_123',
          userId: 'user_123',
          clientId: 'client_123',
          scopes: ['profile', 'email'],
          getToken: expect.any(Function),
          has: expect.any(Function),
        }),
      },
    });
    await expect(authInfo.extra.auth?.getToken()).resolves.toBe(token);
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

// A stub Backend API, so the status Clerk's verifier reports for an answer it got is the one it really derives
describe('verifyClerkOAuthToken when the Backend API fails', () => {
  let status = 503;
  const requests: string[] = [];
  const backendApi = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ code: 'unexpected_error', message: 'down' }] }));
  });
  let apiUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => backendApi.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(backendApi.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => backendApi.close(() => resolve())));
  beforeEach(() => {
    requests.length = 0;
  });

  // No `jwtKey`, so a JWT access token makes Clerk fetch the JWKS from the stub
  const remoteClient = () =>
    createClerkClient({
      secretKey: 'sk_test_clerk_verification',
      publishableKey: 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k',
      apiUrl,
    });

  test.each([503, 500, 429])(
    'throws an McpAuthError with status %i for an opaque token Clerk could not check',
    async (answered) => {
      status = answered;

      const error = await verifyClerkOAuthToken(remoteClient(), 'oat_abc', resourceUrl).catch(
        (thrown: unknown) => thrown,
      );

      expect(requests).toEqual(['POST /oauth_applications/access_tokens/verify']);
      expect(error).toBeInstanceOf(McpAuthError);
      expect(error).toMatchObject({ status: answered });
      expect((error as McpAuthError).cause).toMatchObject({
        code: 'unexpected-error',
        status: answered,
      });
      expect(serverErrorAnswer(error as McpAuthError)).toEqual({
        status: answered,
        body: { error: 'server_error' },
      });
    },
  );

  test.each([400, 422])(
    'rejects an opaque token the Backend API answered with %i for',
    async (answered) => {
      status = answered;

      const error = await verifyClerkOAuthToken(remoteClient(), 'oat_abc', resourceUrl).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(McpTokenVerificationError);
      expect(error).not.toBeInstanceOf(McpAuthError);
      expect(error).toMatchObject({ code: 'unexpected-error', status: answered });
    },
  );

  test('answers a rejected opaque token with the invalid_token challenge', async () => {
    status = 400;

    const result = await authenticateBearer({
      authorization: 'Bearer oat_abc',
      requestUrl: resourceUrl,
      resourceUrl,
      requiredScopes: [],
      challengeScopes: [],
      verifyToken: (token) => verifyClerkOAuthToken(remoteClient(), token, resourceUrl),
    });

    expect(result).toMatchObject({ ok: false, status: 401, failure: { reason: 'invalid_token' } });
    expect(result.ok === false && result.challenge).toContain('error="invalid_token"');
  });

  test('throws an McpAuthError answered with a 500 when the JWKS for a JWT access token cannot be loaded', async () => {
    status = 503;

    const error = await verifyClerkOAuthToken(
      remoteClient(),
      accessToken({ aud: resourceUrl }),
      resourceUrl,
    ).catch((thrown: unknown) => thrown);

    expect(requests).toContain('GET /v1/jwks');
    expect(error).toBeInstanceOf(McpAuthError);
    expect((error as McpAuthError).cause).toMatchObject({
      code: 'token-verification-failed',
      message: expect.stringMatching(/^Error loading Clerk JWKS from .* with code=503/),
    });
    expect(serverErrorAnswer(error as McpAuthError)).toEqual({
      status: 500,
      body: { error: 'server_error' },
    });
  });
});
