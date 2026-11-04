import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler, McpServer as McpServerV2 } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createBrowserSession,
  BrowserSessionError,
  browserSessionErrorMessage,
  createBrowserSessionTool,
  browserSessionInstructions,
  browserSessionToolText,
  validateBrowserSessionOptions,
  type CreateBrowserSessionOptions,
} from './create-browser-session';
import { connectTool, sentBody, textOf } from './test/mcp-harness';

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
  extra: Partial<CreateBrowserSessionOptions> = {},
): CreateBrowserSessionOptions {
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
    Response.json({
      object: 'agent_task',
      agent_id: 'agt_1',
      agent_task_id: 'agttsk_1',
      task_id: 'tsk_1',
      url: LINK,
    }),
  );
}

// Clerk Backend API error shape. `message` carries text that must never reach the agent.
function apiError(code: string, paramName?: string) {
  return {
    code,
    message: `BODY_TEXT ${LINK}`,
    ...(paramName !== undefined && { meta: { param_name: paramName } }),
  };
}

function statusFetch(status: number, body: unknown = { errors: [apiError('some_error')] }) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

function browserSessionError(code: string, extra: Record<string, unknown> = {}) {
  return { name: 'BrowserSessionError', code, message: expect.not.stringMatching(LEAKS), ...extra };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createBrowserSession', () => {
  test('posts an agent task for the token user', async () => {
    const fetchImpl = okFetch();
    const result = await createBrowserSession({ authInfo }, options(fetchImpl));

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
      agentTaskId: 'agttsk_1',
      redirectUrl: 'https://app.example.com/',
    });
  });

  test('uses the agent name option, task description, and path', async () => {
    const fetchImpl = okFetch();
    await createBrowserSession(
      { authInfo, path: '/settings?tab=a#b', taskDescription: 'Check billing' },
      options(fetchImpl, { agentName: 'my-agent' }),
    );
    expect(sentBody(fetchImpl)).toMatchObject({
      agent_name: 'my-agent',
      task_description: 'Check billing',
      redirect_url: 'https://app.example.com/settings?tab=a#b',
    });
  });

  test('keeps the destination unchanged without a path, and replaces its path and query with one', async () => {
    const destinationUrl = 'https://app.example.com/dashboard?x=1';
    const without = await createBrowserSession(
      { authInfo },
      options(okFetch(), { destinationUrl }),
    );
    expect(without.redirectUrl).toBe(destinationUrl);

    const withPath = await createBrowserSession(
      { authInfo, path: '/settings?tab=a#b' },
      options(okFetch(), { destinationUrl }),
    );
    expect(withPath.redirectUrl).toBe('https://app.example.com/settings?tab=a#b');
  });

  test.each(['', '   '])('falls back to the default agent name for %j', async (agentName) => {
    const fetchImpl = okFetch();
    await createBrowserSession({ authInfo }, options(fetchImpl, { agentName }));
    expect(sentBody(fetchImpl).agent_name).toBe('mcp:client_1');
  });

  test('falls back to the default task description when blank', async () => {
    const fetchImpl = okFetch();
    await createBrowserSession({ authInfo, taskDescription: '   ' }, options(fetchImpl));
    expect(sentBody(fetchImpl).task_description).toBe(
      'Signed-in browser session requested through MCP',
    );
  });

  test('names the agent "mcp" without a client id', async () => {
    const fetchImpl = okFetch();
    await createBrowserSession({ authInfo: { ...authInfo, clientId: '' } }, options(fetchImpl));
    expect(sentBody(fetchImpl).agent_name).toBe('mcp');
  });

  test('sends session_max_duration_in_seconds only when set', async () => {
    const without = okFetch();
    await createBrowserSession({ authInfo }, options(without));
    expect(sentBody(without)).not.toHaveProperty('session_max_duration_in_seconds');

    const withIt = okFetch();
    await createBrowserSession({ authInfo }, options(withIt, { sessionMaxDurationInSeconds: 600 }));
    expect(sentBody(withIt).session_max_duration_in_seconds).toBe(600);
  });

  test.each([
    ['no auth info', undefined],
    ['no user id', { ...authInfo, extra: { verifiedBy: 'clerk' } }],
    ['empty user id', { ...authInfo, extra: { userId: '', verifiedBy: 'clerk' } }],
    ['not Clerk-verified', { ...authInfo, extra: { userId: 'user_1' } }],
  ])('refuses without Clerk-verified auth: %s', async (_name, info) => {
    const fetchImpl = okFetch();
    await expect(
      createBrowserSession({ authInfo: info }, options(fetchImpl)),
    ).rejects.toMatchObject(browserSessionError('not_authenticated'));
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
    '/\t/evil.example',
    '/..//evil.example',
    '/.//evil.example',
    // new URL() throws ERR_INVALID_URL for this one.
    '/\n\\]',
    // A malformed percent escape, which Clerk would reject as a bad redirect_url.
    '/%ZZ',
    '/%',
    '/settings%2',
    '/settings?tab=%G1',
  ])('refuses path %j without calling the API', async (path) => {
    const fetchImpl = okFetch();
    await expect(
      createBrowserSession({ authInfo, path }, options(fetchImpl)),
    ).rejects.toMatchObject(browserSessionError('invalid_path'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['', '   '])('treats a blank path %j as omitted', async (path) => {
    const fetchImpl = okFetch();
    const session = await createBrowserSession({ authInfo, path }, options(fetchImpl));
    expect(session.redirectUrl).toBe('https://app.example.com/');
    expect(sentBody(fetchImpl).redirect_url).toBe('https://app.example.com/');
  });

  const redirectUrlErrors = { errors: [apiError('form_param_value_invalid', 'redirect_url')] };
  const permissionsErrors = { errors: [apiError('form_param_value_invalid', 'permissions')] };
  test.each([
    ['401', 'unauthorized', 401, undefined],
    ['403', 'unauthorized', 403, undefined],
    ['400', 'rejected', 400, undefined],
    ['422 without a parameter', 'rejected', 422, undefined],
    ['422 for redirect_url', 'destination_rejected', 422, redirectUrlErrors],
    [
      '422 for an insecure redirect_url',
      'destination_rejected',
      422,
      { errors: [apiError('some_error'), apiError('insecure_url', 'redirect_url')] },
    ],
    ['400 for redirect_url', 'rejected', 400, redirectUrlErrors],
    ['422 for permissions', 'rejected', 422, permissionsErrors],
    ['422 with an unreadable body', 'rejected', 422, 'BODY_TEXT'],
    ['429 for redirect_url', 'rate_limited', 429, redirectUrlErrors],
    ['500', 'unavailable', 500, undefined],
  ])('maps Backend API %s to %s without leaking the body', async (_name, code, status, body) => {
    await expect(
      createBrowserSession({ authInfo }, options(statusFetch(status, body))),
    ).rejects.toMatchObject(browserSessionError(code));
  });

  test('refuses when a required scope is missing, before it checks the path', async () => {
    const fetchImpl = okFetch();
    await expect(
      createBrowserSession(
        { authInfo: { ...authInfo, scopes: ['a'] }, path: 'bad' },
        options(fetchImpl, { requiredScopes: ['a', 'b'] }),
      ),
    ).rejects.toMatchObject(browserSessionError('insufficient_scope', { missingScopes: ['b'] }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('proceeds when all required scopes are present', async () => {
    const fetchImpl = okFetch();
    await createBrowserSession(
      { authInfo: { ...authInfo, scopes: ['a', 'c'] } },
      options(fetchImpl, { requiredScopes: ['a'] }),
    );
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
    await expect(createBrowserSession({ authInfo }, options(fetchImpl))).rejects.toMatchObject(
      browserSessionError('unavailable'),
    );
  });

  test('treats an unreadable success response as unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ nope: true }));
    await expect(createBrowserSession({ authInfo }, options(fetchImpl))).rejects.toMatchObject(
      browserSessionError('unavailable'),
    );
  });
});

describe('validateBrowserSessionOptions', () => {
  const base = {
    secretKey: SECRET,
    destinationUrl: 'https://app.example.com/',
    requiredScopes: [],
  };

  test('accepts valid options, including loopback http', () => {
    expect(() => validateBrowserSessionOptions(base)).not.toThrow();
    expect(() =>
      validateBrowserSessionOptions({
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
    ['destinationUrl with a username', { destinationUrl: 'https://user@app.example.com/' }],
    ['destinationUrl with credentials', { destinationUrl: 'https://user:pass@app.example.com/' }],
    ['empty required scope', { requiredScopes: ['a', ' '] }],
    ['required scope with a space', { requiredScopes: ['profile email'] }],
    ['required scope with a quote', { requiredScopes: ['a"b'] }],
    ['required scope with a backslash', { requiredScopes: ['a\\b'] }],
    ['required scope with a control character', { requiredScopes: ['a\nb'] }],
    ['non-string required scope', { requiredScopes: [1 as unknown as string] }],
    ['missing requiredScopes', { requiredScopes: undefined as unknown as string[] }],
    ['zero session length', { sessionMaxDurationInSeconds: 0 }],
    ['negative session length', { sessionMaxDurationInSeconds: -5 }],
    ['fractional session length', { sessionMaxDurationInSeconds: 1.5 }],
    ['non-string agentName', { agentName: 123 as unknown as string }],
    ['non-function fetch', { fetch: 123 as unknown as typeof fetch }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateBrowserSessionOptions({ ...base, ...patch })).toThrow(/^Clerk error: /);
  });

  test('createBrowserSession validates its options', async () => {
    await expect(
      createBrowserSession({ authInfo }, { ...base, secretKey: '', fetch: okFetch() }),
    ).rejects.toThrow(/^Clerk error: /);
  });
});

describe('browserSessionErrorMessage', () => {
  test.each([
    ['not_authenticated', 'reconnect this MCP server'],
    ['invalid_path', 'Use an absolute path such as /settings'],
    ['unauthorized', 'Do not retry'],
    ['rate_limited', 'Wait'],
    ['unavailable', 'Try again at most once'],
  ] as const)('tells the agent what to do for %s', (code, hint) => {
    expect(browserSessionErrorMessage(new BrowserSessionError(code, 'detail'))).toContain(hint);
  });

  test('names the missing scopes from the error, not its message', () => {
    const message = browserSessionErrorMessage(
      new BrowserSessionError('insufficient_scope', 'detail', ['a', 'b']),
    );
    expect(message).toContain('missing required scopes: a, b.');
    expect(message).toContain('approve those scopes');
    expect(message).toContain('server owner');
    expect(message).toContain('more than once');
    expect(message).not.toContain('detail');
  });

  test('tells the agent not to retry a rejected request without a path', () => {
    const message = browserSessionErrorMessage(new BrowserSessionError('rejected', 'detail'));
    expect(message).toContain('Do not retry');
    expect(message).toContain('Tell the user');
    expect(message).not.toContain('different path');
  });

  test('sends a rejected destination to the server owner, not to another path', () => {
    const message = browserSessionErrorMessage(
      new BrowserSessionError('destination_rejected', 'detail'),
    );
    expect(message).toContain('server owner must check the Clerk configuration');
    expect(message).toContain('Do not retry');
    expect(message).not.toContain('different path');
  });
});

describe('createBrowserSessionTool', () => {
  function connect(
    fetchImpl: typeof fetch,
    auth: AuthInfo | null = authInfo,
    extra: Partial<CreateBrowserSessionOptions> = {},
  ) {
    return connectTool(
      (server) => server.registerTool(...createBrowserSessionTool(options(fetchImpl, extra))),
      { authInfo: auth ?? undefined },
    );
  }

  test('names the destination host in the title and description', async () => {
    const client = await connect(okFetch());
    const { tools } = await client.listTools();
    expect(tools[0]?.title).toBe('Open app.example.com signed in');
    expect(tools[0]?.description).toContain('Opens https://app.example.com in a browser');
    expect(tools[0]?.description).toContain('before you open any page on app.example.com');
    expect(tools[0]?.description).toContain('Never type credentials for app.example.com');
  });

  test('gives short server instructions that name the host and the tool', () => {
    const instructions = browserSessionInstructions('https://app.example.com/dashboard');
    expect(instructions).toContain('app.example.com');
    expect(instructions).toContain('create_browser_session');
    // Some MCP clients show only the first ~200 characters of server instructions.
    expect(instructions.length).toBeLessThanOrEqual(200);
  });

  test('keeps the tool name within the first 200 characters for a long host', () => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.com`;
    const instructions = browserSessionInstructions(`https://${host}/home`);
    expect(instructions).toContain(host);
    expect(instructions.slice(0, 200)).toContain('call create_browser_session');
  });

  test.each(['not a url', 'http://app.example.com/'])(
    'refuses destination %j in the text helpers',
    (destinationUrl) => {
      expect(() => browserSessionInstructions(destinationUrl)).toThrow(/^Clerk error: /);
      expect(() => browserSessionToolText(destinationUrl)).toThrow(/^Clerk error: /);
    },
  );

  test('keeps the port of a loopback destination', () => {
    expect(browserSessionToolText('http://localhost:3000/').title).toBe(
      'Open localhost:3000 signed in',
    );
  });

  describe('required scopes', () => {
    test('the tool keeps requiring the scopes after the array is emptied', async () => {
      const scopes = ['a', 'b'];
      const fetchImpl = okFetch();
      const create = createBrowserSessionTool(options(fetchImpl, { requiredScopes: scopes }));
      scopes.length = 0;
      const result = await create[2]({}, { authInfo: { ...authInfo, scopes: ['a'] } });
      expect(result.isError).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('the registered scope challenge keeps the scopes after the array is emptied', () => {
      const scopes = ['a'];
      const tool = createBrowserSessionTool(options(okFetch(), { requiredScopes: scopes }));
      scopes.length = 0;
      const config = tool[1] as { scopeChallenge?: (c: { authInfo?: AuthInfo }) => unknown };
      expect(config.scopeChallenge?.({ authInfo: { ...authInfo, scopes: [] } })).toEqual({
        scopes: ['a'],
      });
    });
  });

  describe('logging', () => {
    const redirectUrlErrors = {
      errors: [{ code: 'form_param_value_invalid', meta: { param_name: 'redirect_url' } }],
    };

    // Calls the tool callback and returns what it logged and what it told the agent.
    async function callLogged(
      fetchImpl: typeof fetch,
      request: { auth?: AuthInfo; path?: string; requiredScopes?: string[] } = {},
    ) {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const tool = createBrowserSessionTool(
        options(fetchImpl, { requiredScopes: request.requiredScopes ?? [] }),
      );
      const result = await tool[2]({ path: request.path }, { authInfo: request.auth ?? authInfo });
      expect(result.isError).toBe(true);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const [message] = consoleError.mock.calls[0]!;
      expect(message).not.toMatch(LEAKS);
      expect(JSON.stringify(result)).not.toMatch(LEAKS);
      return String(message);
    }

    test('logs the status and the error codes and parameters of a failed response', async () => {
      expect(await callLogged(statusFetch(422, redirectUrlErrors))).toBe(
        'Clerk error: createBrowserSession failed (status 422: form_param_value_invalid redirect_url)',
      );
    });

    test('leaves unexpected error codes and parameters out of the log', async () => {
      const body = { errors: [{ code: `x ${SECRET}`, meta: { param_name: LINK } }] };
      expect(await callLogged(statusFetch(422, body))).toBe(
        'Clerk error: createBrowserSession failed (status 422)',
      );
    });

    test('leaves a secret key shaped error code out of the log', async () => {
      const body = { errors: [{ code: SECRET, meta: { param_name: 'redirect_url' } }] };
      expect(await callLogged(statusFetch(422, body))).toBe(
        'Clerk error: createBrowserSession failed (status 422: redirect_url)',
      );
    });

    test('leaves a secret key shaped error name out of the log', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        const error = new Error('boom');
        error.name = SECRET;
        throw error;
      });
      expect(await callLogged(fetchImpl)).toBe(
        'Clerk error: createBrowserSession failed (unknown error)',
      );
    });

    test('logs the status and code of an unauthorized response', async () => {
      expect(await callLogged(statusFetch(401))).toBe(
        'Clerk error: createBrowserSession failed (status 401: some_error)',
      );
    });

    test.each([
      ['insufficient_scope: b', { auth: { ...authInfo, scopes: ['a'] } }, ['a', 'b']],
      ['not_authenticated', { auth: { ...authInfo, extra: {} } }, []],
      ['invalid_path', { path: `https://evil.example/${SECRET}` }, []],
    ])('logs a refused request as %s', async (reason, request, requiredScopes) => {
      expect(await callLogged(okFetch(), { ...request, requiredScopes })).toBe(
        `Clerk error: createBrowserSession failed (${reason})`,
      );
    });

    test('logs only the error name when Clerk cannot be reached', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        throw new TypeError(`fetch failed ${SECRET} ${LINK}`);
      });
      expect(await callLogged(fetchImpl)).toBe(
        'Clerk error: createBrowserSession failed (TypeError)',
      );
    });

    test.each(['TypeError.sk_test_abc', 'Error_pk_live_abc'])(
      'leaves the error name %s, which embeds a key shape, out of the log',
      async (name) => {
        const fetchImpl = vi.fn<typeof fetch>(async () => {
          const error = new Error('boom');
          error.name = name;
          throw error;
        });
        expect(await callLogged(fetchImpl)).toBe(
          'Clerk error: createBrowserSession failed (unknown error)',
        );
      },
    );

    test('leaves a response code that embeds a key shape out of the log', async () => {
      const body = { errors: [{ code: 'form_param_sk_live_abc' }] };
      expect(await callLogged(statusFetch(422, body))).toBe(
        'Clerk error: createBrowserSession failed (status 422)',
      );
    });

    test('keeps a response code that only contains the letters of a key prefix', async () => {
      const body = { errors: [{ code: 'task_description', meta: { param_name: 'desk_id' } }] };
      expect(await callLogged(statusFetch(422, body))).toBe(
        'Clerk error: createBrowserSession failed (status 422: task_description desk_id)',
      );
    });

    test('leaves an error name that is not an identifier out of the log', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        const error = new Error('boom');
        error.name = 'sk_live_SECRET https://ticket.example';
        throw error;
      });
      expect(await callLogged(fetchImpl)).toBe(
        'Clerk error: createBrowserSession failed (unknown error)',
      );
    });
  });

  test('logs an unexpected error with a fixed category and tells the agent to continue', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A throwing `authInfo` getter stands in for any unexpected error inside the tool.
    const tool = createBrowserSessionTool(options(okFetch()));
    const result = await tool[2]({}, {
      get authInfo(): never {
        throw new TypeError(`${SECRET} ${LINK}`);
      },
    } as never);
    expect(result.isError).toBe(true);
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [message] = consoleError.mock.calls[0]!;
    expect(message).toBe('Clerk error: createBrowserSession tool failed unexpectedly (TypeError)');
    expect(message).not.toMatch(LEAKS);
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
    ['an HTTP error', 'Try again at most once', authInfo, () => statusFetch(500)],
    [
      'a thrown fetch error',
      'Try again at most once',
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
    const client = await connect(okFetch(), authInfo, { requiredScopes: ['sign_in_link'] });
    const result = await client.callTool({ name: 'create_browser_session', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('sign_in_link');
    expect(textOf(result)).toContain('reconnect');
  });

  test('returns a generic error when the failure is not a BrowserSessionError', async () => {
    // A custom fetch that resolves to something other than a Response.
    const client = await connect(vi.fn<typeof fetch>(async () => undefined as never));
    const result = await client.callTool({ name: 'create_browser_session', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'The sign-in link could not be created. Continue without it, or ask the user to sign in.',
    );
  });

  test('validates options when it is built', () => {
    expect(() => createBrowserSessionTool(options(okFetch(), { secretKey: ' ' }))).toThrow(
      'Clerk error:',
    );
  });
});

describe('createBrowserSessionTool on MCP SDK v2', () => {
  function callTool(
    fetchImpl: typeof fetch,
    auth?: AuthInfo,
    extra: Partial<CreateBrowserSessionOptions> = {},
  ) {
    const handler = createMcpHandler(() => {
      const mcp = new McpServerV2({ name: 'test', version: '0.0.0' });
      mcp.registerTool(...createBrowserSessionTool(options(fetchImpl, extra)));
      return mcp;
    });
    return handler.fetch(
      new Request('https://mcp.example.com/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'create_browser_session', arguments: { path: '/settings' } },
        }),
      }),
      { authInfo: auth },
    );
  }

  test('creates the link for the user in ctx.http.authInfo', async () => {
    const fetchImpl = okFetch();
    // `options` sets `requiredScopes: []`, so the registration scope challenge never fires.
    const response = await callTool(fetchImpl, authInfo);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('agttsk_1');
    expect(sentBody(fetchImpl)).toMatchObject({
      on_behalf_of: { user_id: 'user_1' },
      redirect_url: 'https://app.example.com/settings',
    });
  });

  test('refuses without auth info', async () => {
    const fetchImpl = okFetch();
    const response = await callTool(fetchImpl);
    expect(await response.text()).toContain('reconnect this MCP server');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('answers a missing required scope with the 403 step-up challenge, keeping the granted scopes', async () => {
    const fetchImpl = okFetch();
    const response = await callTool(
      fetchImpl,
      { ...authInfo, scopes: ['profile'], resource: new URL('https://mcp.example.com/mcp') },
      { requiredScopes: ['email', 'user:org:read'] },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", error_description="Insufficient scope", scope="profile email user:org:read", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('leaves resource_metadata out of the challenge when auth info has no resource', async () => {
    const response = await callTool(
      okFetch(),
      { ...authInfo, scopes: ['email'] },
      { requiredScopes: ['user:org:read'] },
    );
    expect(response.status).toBe(403);
    const header = response.headers.get('www-authenticate');
    expect(header).toContain('error="insufficient_scope"');
    expect(header).not.toContain('resource_metadata');
  });

  test('leaves a granted scope that is not a scope-token out of the challenge', async () => {
    const response = await callTool(
      okFetch(),
      { ...authInfo, scopes: ['bad"scope', 'email'] },
      { requiredScopes: ['user:org:read'] },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('scope="email user:org:read"');
  });

  test('runs the tool when the token has the required scopes', async () => {
    const fetchImpl = okFetch();
    const response = await callTool(
      fetchImpl,
      { ...authInfo, scopes: ['user:org:read'] },
      { requiredScopes: ['user:org:read'] },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('agttsk_1');
  });

  test('leaves a request without auth info to the tool, which refuses it', async () => {
    const fetchImpl = okFetch();
    const response = await callTool(fetchImpl, undefined, { requiredScopes: ['user:org:read'] });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('reconnect this MCP server');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
