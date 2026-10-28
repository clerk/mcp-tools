import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createSignInLink,
  DEFAULT_SIGN_IN_LINK_TASK_DESCRIPTION,
  resolveRedirectUrl,
  SignInLinkError,
  validateSignInLinkOptions,
  type SignInLinkOptions,
} from './sign-in-link';

const authInfo: AuthInfo = {
  token: 't',
  clientId: 'client_1',
  scopes: [],
  extra: { userId: 'user_1', verifiedBy: 'clerk' },
};

const SECRET = 'sk_test_123';
const LINK = 'https://accounts.example.com/v1/tickets/accept?ticket=SECRET_TICKET';

function options(
  fetchImpl: typeof fetch,
  extra: Partial<SignInLinkOptions> = {},
): SignInLinkOptions {
  return {
    secretKey: SECRET,
    destinationUrl: 'https://app.example.com/',
    apiUrl: 'https://api.clerk.test',
    fetch: fetchImpl,
    now: () => new Date('2026-10-28T00:00:00Z'),
    ...extra,
  };
}

function okFetch() {
  return vi.fn<typeof fetch>(async () =>
    Response.json({ url: LINK, agent_task_id: 'agttsk_1', task_id: 'old' }, { status: 200 }),
  );
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [, init] = fetchImpl.mock.calls[0]!;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as SignInLinkError;
  }
  throw new Error('expected rejection');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSignInLink', () => {
  test('posts an agent task for the token user', async () => {
    const fetchImpl = okFetch();
    const result = await createSignInLink(options(fetchImpl), { authInfo });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.clerk.test/v1/agents/tasks');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(sentBody(fetchImpl)).toEqual({
      on_behalf_of: { user_id: 'user_1' },
      permissions: '*',
      agent_name: 'mcp:client_1',
      task_description: DEFAULT_SIGN_IN_LINK_TASK_DESCRIPTION,
      redirect_url: 'https://app.example.com/',
    });
    expect(result).toEqual({
      url: LINK,
      agent_task_id: 'agttsk_1',
      expires_at: '2026-10-28T01:00:00.000Z',
      redirect_url: 'https://app.example.com/',
    });
  });

  test('uses the agent name option, task description, and path', async () => {
    const fetchImpl = okFetch();
    await createSignInLink(options(fetchImpl, { agentName: 'my-agent' }), {
      authInfo,
      path: '/settings?tab=a#b',
      taskDescription: 'Check billing',
    });
    expect(sentBody(fetchImpl)).toMatchObject({
      agent_name: 'my-agent',
      task_description: 'Check billing',
      redirect_url: 'https://app.example.com/settings?tab=a#b',
    });
  });

  test('falls back to the default task description when blank', async () => {
    const fetchImpl = okFetch();
    await createSignInLink(options(fetchImpl), { authInfo, taskDescription: '   ' });
    expect(sentBody(fetchImpl).task_description).toBe(DEFAULT_SIGN_IN_LINK_TASK_DESCRIPTION);
  });

  test('names the agent "mcp" without a client id', async () => {
    const fetchImpl = okFetch();
    await createSignInLink(options(fetchImpl), { authInfo: { ...authInfo, clientId: '' } });
    expect(sentBody(fetchImpl).agent_name).toBe('mcp');
  });

  test('sends session_max_duration_in_seconds only when set', async () => {
    const without = okFetch();
    await createSignInLink(options(without), { authInfo });
    expect(sentBody(without)).not.toHaveProperty('session_max_duration_in_seconds');

    const withIt = okFetch();
    await createSignInLink(options(withIt, { sessionMaxDurationInSeconds: 600 }), { authInfo });
    expect(sentBody(withIt).session_max_duration_in_seconds).toBe(600);
  });

  test.each([
    ['no auth info', undefined],
    ['no user id', { ...authInfo, extra: { verifiedBy: 'clerk' } }],
    ['not Clerk-verified', { ...authInfo, extra: { userId: 'user_1' } }],
  ])('refuses without Clerk-verified auth: %s', async (_name, info) => {
    const fetchImpl = okFetch();
    const error = await failure(createSignInLink(options(fetchImpl), { authInfo: info }));
    expect(error).toBeInstanceOf(SignInLinkError);
    expect(error.code).toBe('not_authenticated');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '\\\\evil.example',
    'settings',
    '',
    '/\t/evil.example',
  ])('refuses hostile path %j without calling the API', async (path) => {
    const fetchImpl = okFetch();
    const error = await failure(createSignInLink(options(fetchImpl), { authInfo, path }));
    expect(error.code).toBe('invalid_path');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('ignores a user id smuggled in the request', async () => {
    const fetchImpl = okFetch();
    await createSignInLink(options(fetchImpl), {
      authInfo,
      user_id: 'user_evil',
      on_behalf_of: { user_id: 'user_evil' },
    } as never);
    expect(sentBody(fetchImpl).on_behalf_of).toEqual({ user_id: 'user_1' });
  });

  test.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [400, 'rejected'],
    [422, 'rejected'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
  ])('maps BAPI status %i to %s without leaking the body', async (status, code) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ errors: [{ message: `BODY_TEXT ${LINK}` }] }, { status }),
    );
    const error = await failure(createSignInLink(options(fetchImpl), { authInfo }));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('BODY_TEXT');
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('SECRET_TICKET');
  });

  test.each([
    ['network error', new TypeError(`fetch failed ${SECRET}`)],
    ['timeout', new DOMException('timed out', 'TimeoutError')],
    ['abort', new DOMException('aborted', 'AbortError')],
  ])('maps a %s to unavailable', async (_name, thrown) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw thrown;
    });
    const error = await failure(createSignInLink(options(fetchImpl), { authInfo }));
    expect(error.code).toBe('unavailable');
    expect(error.message).not.toContain(SECRET);
  });

  test('treats an unreadable success response as unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ nope: true }));
    const error = await failure(createSignInLink(options(fetchImpl), { authInfo }));
    expect(error.code).toBe('unavailable');
  });

  test('never logs the link', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await createSignInLink(options(okFetch()), { authInfo });
    const failing = vi.fn<typeof fetch>(async () => Response.json({ url: LINK }, { status: 500 }));
    await failure(createSignInLink(options(failing), { authInfo }));
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET_TICKET');
    }
  });
});

describe('resolveRedirectUrl', () => {
  test('returns the destination unchanged without a path', () => {
    expect(resolveRedirectUrl('https://app.example.com/dashboard?x=1', undefined)).toBe(
      'https://app.example.com/dashboard?x=1',
    );
  });

  test('replaces the destination path and query with the agent path', () => {
    expect(resolveRedirectUrl('https://app.example.com/dashboard?x=1', '/settings?tab=a#b')).toBe(
      'https://app.example.com/settings?tab=a#b',
    );
  });
});

describe('validateSignInLinkOptions', () => {
  const base = { secretKey: SECRET, destinationUrl: 'https://app.example.com/' };

  test('accepts valid options, including loopback http', () => {
    expect(() => validateSignInLinkOptions(base)).not.toThrow();
    expect(() =>
      validateSignInLinkOptions({
        ...base,
        destinationUrl: 'http://localhost:3000/',
        apiUrl: 'http://127.0.0.1:8080',
        sessionMaxDurationInSeconds: 60,
      }),
    ).not.toThrow();
  });

  test.each([
    ['empty key', { secretKey: ' ' }],
    ['insecure apiUrl', { apiUrl: 'http://api.example.com' }],
    ['invalid apiUrl', { apiUrl: 'not a url' }],
    ['insecure destinationUrl', { destinationUrl: 'http://app.example.com/' }],
    ['zero session length', { sessionMaxDurationInSeconds: 0 }],
    ['negative session length', { sessionMaxDurationInSeconds: -5 }],
    ['fractional session length', { sessionMaxDurationInSeconds: 1.5 }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateSignInLinkOptions({ ...base, ...patch })).toThrow(/^Clerk error: /);
  });

  test('createSignInLink validates its options', async () => {
    const error = await createSignInLink(
      { ...base, secretKey: '', fetch: okFetch() },
      { authInfo },
    ).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^Clerk error: /);
  });
});
