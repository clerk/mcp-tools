import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createSignInLink,
  SignInLinkError,
  signInLinkErrorMessage,
  signInLinkTool,
  signInLinkToolText,
  validateSignInLinkOptions,
  type SignInLinkOptions,
} from './sign-in-link';
import { connectTool, textOf } from './test/mcp-harness';

const authInfo: AuthInfo = {
  token: 't',
  clientId: 'client_1',
  scopes: [],
  extra: { userId: 'user_1', verifiedBy: 'clerk' },
};

const SECRET = 'sk_test_123';
const LINK = 'https://accounts.example.com/v1/tickets/accept?ticket=SECRET_TICKET';
const LEAKS = /BODY_TEXT|sk_test_123|SECRET_TICKET/;

function options(
  fetchImpl: typeof fetch,
  extra: Partial<SignInLinkOptions> = {},
): SignInLinkOptions {
  return {
    secretKey: SECRET,
    destinationUrl: 'https://app.example.com/',
    apiUrl: 'https://api.clerk.test',
    fetch: fetchImpl,
    requiredScopes: [],
    ...extra,
  };
}

// The full Backend API response; only url and agent_task_id are read.
function okFetch() {
  return vi.fn<typeof fetch>(async () =>
    Response.json(
      {
        object: 'agent_task',
        agent_id: 'agt_1',
        agent_task_id: 'agttsk_1',
        task_id: 'tsk_1',
        url: LINK,
      },
      { status: 200 },
    ),
  );
}

function statusFetch(status: number) {
  return vi.fn<typeof fetch>(async () =>
    Response.json({ errors: [{ message: `BODY_TEXT ${LINK}` }] }, { status }),
  );
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [, init] = fetchImpl.mock.calls[0]!;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function signInLinkError(code: string, extra: Record<string, unknown> = {}) {
  return { name: 'SignInLinkError', code, message: expect.not.stringMatching(LEAKS), ...extra };
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
      task_description: 'Signed-in browser session requested through MCP',
      redirect_url: 'https://app.example.com/',
    });
    expect(result).toEqual({
      url: LINK,
      agent_task_id: 'agttsk_1',
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

  test('keeps the destination unchanged without a path, and replaces its path and query with one', async () => {
    const destinationUrl = 'https://app.example.com/dashboard?x=1';
    const without = await createSignInLink(options(okFetch(), { destinationUrl }), { authInfo });
    expect(without.redirect_url).toBe(destinationUrl);

    const withPath = await createSignInLink(options(okFetch(), { destinationUrl }), {
      authInfo,
      path: '/settings?tab=a#b',
    });
    expect(withPath.redirect_url).toBe('https://app.example.com/settings?tab=a#b');
  });

  test.each(['', '   '])('falls back to the default agent name for %j', async (agentName) => {
    const fetchImpl = okFetch();
    await createSignInLink(options(fetchImpl, { agentName }), { authInfo });
    expect(sentBody(fetchImpl).agent_name).toBe('mcp:client_1');
  });

  test('falls back to the default task description when blank', async () => {
    const fetchImpl = okFetch();
    await createSignInLink(options(fetchImpl), { authInfo, taskDescription: '   ' });
    expect(sentBody(fetchImpl).task_description).toBe(
      'Signed-in browser session requested through MCP',
    );
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
    ['empty user id', { ...authInfo, extra: { userId: '', verifiedBy: 'clerk' } }],
    ['not Clerk-verified', { ...authInfo, extra: { userId: 'user_1' } }],
  ])('refuses without Clerk-verified auth: %s', async (_name, info) => {
    const fetchImpl = okFetch();
    await expect(createSignInLink(options(fetchImpl), { authInfo: info })).rejects.toMatchObject(
      signInLinkError('not_authenticated'),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    'https://evil.example',
    '//evil.example',
    '//app.example.com/settings',
    '/\\evil.example',
    'javascript:alert(1)',
    '\\\\evil.example',
    'settings',
    '',
    '/\t/evil.example',
    '/..//evil.example',
    '/.//evil.example',
    // new URL() throws ERR_INVALID_URL for this one.
    '/\n\\]',
  ])('refuses hostile path %j without calling the API', async (path) => {
    const fetchImpl = okFetch();
    await expect(createSignInLink(options(fetchImpl), { authInfo, path })).rejects.toMatchObject(
      signInLinkError('invalid_path'),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    [401, undefined, 'unauthorized'],
    [403, undefined, 'unauthorized'],
    [400, undefined, 'rejected'],
    [422, undefined, 'rejected'],
    [422, '/settings', 'path_rejected'],
    [429, '/settings', 'rate_limited'],
    [500, undefined, 'unavailable'],
  ])(
    'maps Backend API status %i (path %s) to %s without leaking the body',
    async (status, path, code) => {
      await expect(
        createSignInLink(options(statusFetch(status)), { authInfo, path }),
      ).rejects.toMatchObject(signInLinkError(code));
    },
  );

  test('cancels the response body on a failed response', async () => {
    const cancel = vi.fn(async () => {});
    const response = new Response('x', { status: 500 });
    Object.defineProperty(response, 'body', { value: { cancel } });
    const fetchImpl = vi.fn<typeof fetch>(async () => response);
    await expect(createSignInLink(options(fetchImpl), { authInfo })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('refuses when a required scope is missing', async () => {
    const fetchImpl = okFetch();
    await expect(
      createSignInLink(options(fetchImpl, { requiredScopes: ['a', 'b'] }), {
        authInfo: { ...authInfo, scopes: ['a'] },
        path: 'bad',
      }),
    ).rejects.toMatchObject(signInLinkError('insufficient_scope', { missingScopes: ['b'] }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('proceeds when all required scopes are present', async () => {
    const fetchImpl = okFetch();
    await createSignInLink(options(fetchImpl, { requiredScopes: ['a'] }), {
      authInfo: { ...authInfo, scopes: ['a', 'c'] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['network error', new TypeError(`fetch failed ${SECRET}`)],
    ['timeout', new DOMException('timed out', 'TimeoutError')],
    ['abort', new DOMException('aborted', 'AbortError')],
  ])('maps a %s to unavailable', async (_name, thrown) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw thrown;
    });
    await expect(createSignInLink(options(fetchImpl), { authInfo })).rejects.toMatchObject(
      signInLinkError('unavailable'),
    );
  });

  test('treats an unreadable success response as unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ nope: true }));
    await expect(createSignInLink(options(fetchImpl), { authInfo })).rejects.toMatchObject(
      signInLinkError('unavailable'),
    );
  });
});

describe('validateSignInLinkOptions', () => {
  const base = {
    secretKey: SECRET,
    destinationUrl: 'https://app.example.com/',
    requiredScopes: [],
  };

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
    ['empty required scope', { requiredScopes: ['a', ' '] }],
    ['missing requiredScopes', { requiredScopes: undefined as unknown as string[] }],
    ['zero session length', { sessionMaxDurationInSeconds: 0 }],
    ['negative session length', { sessionMaxDurationInSeconds: -5 }],
    ['fractional session length', { sessionMaxDurationInSeconds: 1.5 }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateSignInLinkOptions({ ...base, ...patch })).toThrow(/^Clerk error: /);
  });

  test('createSignInLink validates its options', async () => {
    await expect(
      createSignInLink({ ...base, secretKey: '', fetch: okFetch() }, { authInfo }),
    ).rejects.toThrow(/^Clerk error: /);
  });
});

describe('signInLinkErrorMessage', () => {
  test.each([
    ['not_authenticated', 'reconnect this MCP server'],
    ['invalid_path', 'Use an absolute path such as /settings'],
    ['unauthorized', 'Do not retry'],
    ['rate_limited', 'Wait'],
    ['unavailable', 'Try again in a moment'],
  ] as const)('tells the agent what to do for %s', (code, hint) => {
    expect(signInLinkErrorMessage(new SignInLinkError(code, 'detail'))).toContain(hint);
  });

  test('names the missing scopes from the error, not its message', () => {
    const message = signInLinkErrorMessage(
      new SignInLinkError('insufficient_scope', 'detail', ['a', 'b']),
    );
    expect(message).toContain('missing required scopes: a, b.');
    expect(message).toContain('approve those scopes');
    expect(message).not.toContain('detail');
  });

  test('tells the agent not to retry a rejected request without a path', () => {
    const message = signInLinkErrorMessage(new SignInLinkError('rejected', 'detail'));
    expect(message).toContain('Do not retry');
    expect(message).toContain('Tell the user');
    expect(message).not.toContain('different path');
  });

  test('suggests a different path for a rejected path', () => {
    const message = signInLinkErrorMessage(new SignInLinkError('path_rejected', 'detail'));
    expect(message).toContain('different path');
    expect(message).not.toContain('Do not retry');
  });
});

describe('signInLinkTool', () => {
  function connect(fetchImpl: typeof fetch, auth: AuthInfo | null = authInfo) {
    return connectTool(signInLinkTool(options(fetchImpl)), { authInfo: auth ?? undefined });
  }

  test('names the destination host in the title and description', async () => {
    const client = await connect(okFetch());
    const { tools } = await client.listTools();
    expect(tools[0]?.title).toBe('Open app.example.com signed in');
    expect(tools[0]?.description).toContain('Opens https://app.example.com in a browser');
    expect(tools[0]?.description).toContain('before you open any page on app.example.com');
    expect(tools[0]?.description).toContain('Never type credentials for app.example.com');
  });

  test('keeps the port of a loopback destination', () => {
    expect(signInLinkToolText('http://localhost:3000/').title).toBe(
      'Open localhost:3000 signed in',
    );
  });

  test('returns the link as structured content', async () => {
    const client = await connect(okFetch());
    const result = await client.callTool({ name: 'create_browser_session', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      url: LINK,
      agent_task_id: 'agttsk_1',
      redirect_url: 'https://app.example.com/',
    });
    expect(textOf(result)).toContain(LINK);
    expect(textOf(result)).toContain('single use');
  });

  test('passes the path and task description through', async () => {
    const fetchImpl = okFetch();
    const client = await connect(fetchImpl);
    await client.callTool({
      name: 'create_browser_session',
      arguments: { path: '/settings', task_description: 'Check billing' },
    });
    expect(sentBody(fetchImpl)).toMatchObject({
      redirect_url: 'https://app.example.com/settings',
      task_description: 'Check billing',
    });
  });

  test('ignores user_id in tool input', async () => {
    const fetchImpl = okFetch();
    const client = await connect(fetchImpl);
    await client.callTool({
      name: 'create_browser_session',
      arguments: { user_id: 'user_evil', on_behalf_of: { user_id: 'user_evil' } },
    });
    expect(sentBody(fetchImpl).on_behalf_of).toEqual({ user_id: 'user_1' });
  });

  test.each([
    ['a refusal before the API call', 'reconnect this MCP server', null, () => okFetch()],
    ['an HTTP error', 'Try again in a moment', authInfo, () => statusFetch(500)],
    [
      'a thrown fetch error',
      'Try again in a moment',
      authInfo,
      () =>
        vi.fn<typeof fetch>(async () => {
          throw new Error(`boom ${LINK}`);
        }),
    ],
  ])('returns a tool error for %s', async (_name, hint, auth, makeFetch) => {
    const client = await connect(makeFetch(), auth);
    const result = await client.callTool({ name: 'create_browser_session', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(hint);
    expect(textOf(result)).not.toMatch(LEAKS);
  });

  test('tells the agent which scopes to reconnect with', async () => {
    const client = await connectTool(
      signInLinkTool(options(okFetch(), { requiredScopes: ['sign_in_link'] })),
      { authInfo },
    );
    const result = await client.callTool({ name: 'create_browser_session', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('sign_in_link');
    expect(textOf(result)).toContain('reconnect');
  });

  test('returns a generic error when the failure is not a SignInLinkError', async () => {
    // A custom fetch that resolves to something other than a Response.
    const client = await connect(vi.fn<typeof fetch>(async () => undefined as never));
    const result = await client.callTool({ name: 'create_browser_session', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'The sign-in link could not be created. Continue without it, or ask the user to sign in.',
    );
  });

  test('validates options once, when it is built', async () => {
    expect(() => signInLinkTool(options(okFetch(), { secretKey: ' ' }))).toThrow('Clerk error:');

    const opts = options(okFetch());
    const client = await connectTool(signInLinkTool(opts), { authInfo });
    // A per-request check would now refuse the empty key; the tool must not re-validate.
    opts.secretKey = '';
    const result = await client.callTool({ name: 'create_browser_session', arguments: {} });
    expect(result.isError).toBeFalsy();
  });
});
