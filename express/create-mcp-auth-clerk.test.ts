import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@clerk/express', () => ({
  authenticateRequest: vi.fn(),
  clerkClient: { stand: 'in' },
  getAuth: vi.fn(),
}));

import { authenticateRequest } from '@clerk/express';

import { jwtWith } from '../test/jwt';
import { createMcpAuthClerk } from './index';

const oauthAuth = {
  isAuthenticated: true,
  tokenType: 'oauth_token',
  clientId: 'client-1',
  scopes: ['email'],
  userId: 'user-1',
};

const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((server) => server.close());
  vi.mocked(authenticateRequest).mockReset();
});

function verifiedAs(authObject: object) {
  vi.mocked(authenticateRequest).mockResolvedValue({ toAuth: () => authObject } as never);
}

async function start(options: Parameters<typeof createMcpAuthClerk>[0]) {
  const app = express();
  app.post('/mcp', createMcpAuthClerk(options), (req, res) => {
    res.json((req as unknown as { auth: unknown }).auth);
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (headers: Record<string, string> = { authorization: 'Bearer valid-token' }) =>
    fetch(`${origin}/mcp`, { method: 'POST', headers });
  return { post, origin };
}

describe('createMcpAuthClerk', () => {
  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '  '],
    ['an empty list', []],
    ['a list with an empty value', ['https://mcp.example.com/mcp', '']],
    ['not a string', 42],
  ])('throws when the audience is %s', (_name, audience) => {
    expect(() => createMcpAuthClerk({ audience } as never)).toThrow(/^Clerk error: /);
  });

  test('throws when resourceMetadataUrl is not an HTTPS URL', () => {
    expect(() =>
      createMcpAuthClerk({ audience: 'a', resourceMetadataUrl: 'http://example.com/prm' }),
    ).toThrow(/^Clerk error: .*resourceMetadataUrl/);
  });

  test('verifies the token for the audience as an OAuth token', async () => {
    verifiedAs(oauthAuth);
    const { post } = await start({ audience: ['https://mcp.example.com/mcp', 'x'] });
    expect((await post()).status).toBe(200);
    expect(authenticateRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { acceptsToken: 'oauth_token', audience: ['https://mcp.example.com/mcp', 'x'] },
      }),
    );
  });

  test('sets resourceMetadataUrl to the URL that the 401 advertises', async () => {
    verifiedAs(oauthAuth);
    const { post, origin } = await start({ audience: 'a' });
    expect(await (await post()).json()).toEqual({
      token: 'valid-token',
      scopes: ['email'],
      clientId: 'client-1',
      extra: { userId: 'user-1', verifiedBy: 'clerk' },
      resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    });
  });

  test('lets resourceMetadataUrl override the default', async () => {
    verifiedAs(oauthAuth);
    const resourceMetadataUrl =
      'https://public.example.com/.well-known/oauth-protected-resource/mcp';
    const { post } = await start({ audience: 'a', resourceMetadataUrl });
    expect(await (await post()).json()).toMatchObject({ resourceMetadataUrl });
  });

  test('answers 401 when Clerk does not authenticate the token', async () => {
    verifiedAs({ isAuthenticated: false });
    const { post } = await start({ audience: 'a' });
    expect((await post()).status).toBe(401);
  });

  test('answers 401 with the metadata URL when there is no token', async () => {
    const { post, origin } = await start({ audience: 'a' });
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata=${origin}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  describe('audience check of its own, when Clerk verification succeeds', () => {
    const audience = 'https://mcp.example.com/mcp';
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    test.each([
      ['has no aud', {}],
      ['has an empty aud', { aud: '' }],
      ['has an empty aud list', { aud: [] }],
      ['is for another resource', { aud: 'https://other.example.com/mcp' }],
    ])('answers 401 for a JWT that %s', async (_name, claims) => {
      verifiedAs(oauthAuth);
      const { post } = await start({ audience });
      expect((await post(bearer(jwtWith(claims)))).status).toBe(401);
    });

    test('passes a JWT whose aud matches, with that token in the auth info', async () => {
      verifiedAs(oauthAuth);
      const { post } = await start({ audience });
      const token = jwtWith({ aud: [audience, 'x'] });
      const res = await post(bearer(token));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ token });
    });
  });
});
