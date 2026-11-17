// The bearer-token rules that the Express, Hono, and Next.js adapters share. This module is not a package entry point.
import type { MachineTokenVerificationErrorCode } from '@clerk/backend/errors';
import type { AuthInfo } from './mcp-types';
import { copyClerkVerification } from './clerk-auth-info';
import { deriveFapiUrl } from './publishable-key';
import { assertPropertiesOmitResource } from './resource-metadata-properties';
import { type McpResourceUrl, assertResourceUrls, matchResourceUrl } from './resource-url';
import { assertScopeTokens, challengeScopes } from './scope-challenge';
import {
  type ClerkOAuthClient,
  type McpAuthFailure,
  type McpPublicMethod,
  type PublicAccess,
  McpAuthError,
  McpTokenVerificationError,
  fetchAuthorizationServerMetadata,
  generateProtectedResourceMetadata,
  isClerkAuthInfo,
  metadataCorsHeaders,
  toClerkAuthInfo,
} from './server';

/**
 * The options every auth entry point takes, with `resourceUrl` optional as it is for a custom verifier.
 */
type BaseAuthOptions = {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one
   * for each origin the server answers on. A request uses the listed URL with its origin, and a request to any other
   * origin gets a 421. A single URL is used whatever origin the request has, so it works behind a proxy as it is. Only
   * a list is matched against the request's origin, which is the origin of the URL the framework gives the app, not
   * always the one the client used. Behind a proxy that terminates TLS or rewrites `Host`, or on a server that builds
   * that URL from the address it listens on instead of the `Host` header, rebuild it from the `Host` or
   * `X-Forwarded-*` headers you trust (in Express, set `trust proxy`), or pass a single URL. Never list the internal
   * URLs: each listed URL is an audience and a metadata `resource`, and clients connect to the public one.
   * The challenge's `resource_metadata` is derived from it.
   * With `verifyToken` it can be omitted, and it is then derived from the incoming request, which can differ from the
   * public URL in the same cases. With `verifyToken` and `resourceUrl`, a token whose auth info has a `resource` other
   * than the URL for the request is rejected with `invalid_token`. Without `verifyToken` it is required: Clerk
   * rejects a token whose `aud` claim does not include the URL for the request's origin, so a token issued for one
   * listed URL does not pass on another. Pass the same value to `protectedResourceMetadataHandler`, so its `resource`
   * is the URL checked here.
   */
  resourceUrl?: McpResourceUrl | undefined;
  /**
   * The scopes every request needs. A token without them gets a 403 `insufficient_scope` challenge, and the 401
   * challenge lists them in its `scope`. Only these decide whether a request gets the 403.
   */
  requiredScopes?: readonly string[] | undefined;
  /**
   * More scopes for the 401 challenge's `scope`, after `requiredScopes`, such as the scopes individual tools step up
   * to. MCP clients request the 401 challenge's `scope` when they first authorize, so listing them saves a later
   * step-up. A token is not required to have them: a token without them alone is let through. When a token lacks a
   * `requiredScopes` entry, the 403 also asks for the ones it lacks here, so list each tool's
   * `requireAdditionalScopes` scopes here to have the client reauthorize once, not once for the 403 and again for the
   * tool's own step-up.
   */
  challengeScopes?: readonly string[] | undefined;
  /**
   * What a request without an `Authorization` header may do. Without it, every such request gets the 401 challenge.
   * With it, a POST passes without auth info when every JSON-RPC message in its body is open: a protocol method in
   * `methods`, a `tools/call` for a tool in `tools`, a `resources/read` that `resources` opens, or a `prompts/get`
   * that `prompts` opens. Anything else still gets the 401 challenge, which is what makes an MCP client start authorization only
   * when it reaches something protected. A request with a token is verified as usual.
   */
  publicAccess?: PublicAccess | undefined;
};

/**
 * The branch of every adapter's options union that verifies tokens with the caller's function, for the framework's
 * request type `Req`. `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
type CustomVerifierAuthOptions<Req> = BaseAuthOptions & {
  /**
   * Verifies a token in place of Clerk and returns its auth info, or `undefined` to reject it. Throw an
   * `McpTokenVerificationError` to reject it with a reason. When the auth info has a `resource` and `resourceUrl` is
   * set, the token is rejected unless `resource` is the URL for the request; leave `resource` unset when the verifier
   * does not know it. The token comes first and the request second, the reverse of the verifier `withMcpAuth` from
   * `mcp-handler` takes.
   * @param token - The bearer token from the request
   * @param request - The framework's request or context
   * @returns The token's auth info, or `undefined` to reject it, or a promise of either
   */
  verifyToken: (
    token: string,
    request: Req,
  ) => AuthInfo | undefined | Promise<AuthInfo | undefined>;
  clerkClient?: never;
};

/**
 * Base for each adapter's `McpAuthOptions`.
 */
export type MiddlewareAuthOptions<Req> =
  | (BaseAuthOptions & {
      resourceUrl: McpResourceUrl;
      /**
       * The Clerk client that verifies tokens, or a function that returns one, called once for each request, such as
       * to read the keys when a request arrives.
       */
      clerkClient?:
        | ClerkOAuthClient
        | (() => ClerkOAuthClient | Promise<ClerkOAuthClient>)
        | undefined;
      verifyToken?: never;
    })
  | CustomVerifierAuthOptions<Req>;

/**
 * Base for each adapter's `ProtectedResourceMetadataOptions`.
 */
export type ProtectedResourceMetadataOptions<
  AuthOptions extends BaseAuthOptions = BaseAuthOptions,
> = Partial<AuthOptions> & {
  /**
   * Additional metadata, such as `resource_name`. It overrides the generated metadata, except `resource`, which it
   * cannot set: that is `resourceUrl`, the URL `mcpAuth` checks (RFC 9728 section 3.3). Without `scopes_supported`,
   * the metadata lists `requiredScopes` then `challengeScopes`, each once. A `scopes_supported` given here is used
   * as is, and must list every one of them.
   */
  properties?: Record<string, unknown> | undefined;
};

// The keys of the `McpAuthOptions` every adapter shares. An adapter whose options declare more passes those keys
// to the check itself. Metadata additionally accepts `properties`.
const mcpAuthOptionKeys: ReadonlySet<string> = new Set<keyof MiddlewareAuthOptions<unknown>>([
  'resourceUrl',
  'requiredScopes',
  'challengeScopes',
  'publicAccess',
  'clerkClient',
  'verifyToken',
]);
const protectedResourceMetadataOptionKeys: ReadonlySet<string> = new Set([
  ...mcpAuthOptionKeys,
  'properties',
]);

// What `bearerAuthenticator` decides for a request: let it through, with `authInfo` `undefined` for a request without
// a token that `publicAccess` let through, or answer it. `failure` is `undefined` only for the 400 to a request
// without a URL and the 405 to a GET on a server whose handshake is public, which are not auth failures.
type BearerResult =
  | { ok: true; authInfo: (AuthInfo & { resourceMetadataUrl: string }) | undefined }
  | {
      ok: false;
      failure: McpAuthFailure | undefined;
      status: 400 | 401 | 403 | 405 | 421;
      headers: Record<string, string>;
      body: typeof methodNotAllowed.body | { error: string };
    };

// Every `McpPublicMethod`, for checking a `publicAccess.methods` list and for `methods: true`
const publicMethods: ReadonlySet<string> = new Set<McpPublicMethod>([
  'initialize',
  'server/discover',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

const publicAccessKeys: ReadonlySet<string> = new Set<keyof PublicAccess>([
  'methods',
  'tools',
  'resources',
  'prompts',
]);

// The methods that run something, and how `publicAccess` opens each. They are not valid in `methods`, so that
// listing one cannot open every tool, resource, or prompt at once.
const callMethodHints: Readonly<Record<string, string>> = {
  'tools/call': 'name the tools in publicAccess.tools',
  'resources/read': 'set publicAccess.resources to true or a list of resource URIs',
  'prompts/get': 'set publicAccess.prompts to true or a list of prompt names',
};

/**
 * The largest body, in bytes, read from a request without a token to decide whether `publicAccess` opens it. A larger
 * one gets the 401 challenge unread, so that an unauthenticated client cannot make the server buffer more than this.
 * In Express, `express.json()` reads the body before `mcpAuth` does, so its `limit` (100kb by default) bounds decoded
 * buffering, not encoded ingress. Content-encoded bodies require a token; an identity body whose `Content-Length`
 * is over this limit still gets the 401.
 */
export const PUBLIC_BODY_LIMIT = 1024 * 1024;

/**
 * Throws a `Clerk error:` message unless `publicAccess` is `undefined` or a valid `PublicAccess`: an object with
 * only its four keys, `methods` a boolean or a list of `McpPublicMethod`s, `tools` a list of tool names, and
 * `resources` and `prompts` each a boolean or a list of resource URIs or prompt names. A mistake here would
 * otherwise only show as requests answered with a 401.
 * @param caller - The entry point named in the message, such as `mcpAuth`
 * @param publicAccess - The option's value, unchecked
 */
export function assertPublicAccess(caller: string, publicAccess: unknown) {
  if (publicAccess === undefined) return;
  if (typeof publicAccess !== 'object' || publicAccess === null || Array.isArray(publicAccess)) {
    throw new Error(
      `Clerk error: ${caller} publicAccess must be an object, such as { methods: true, tools: ['search_docs'] }`,
    );
  }
  const unknownKey = Object.keys(publicAccess).find((key) => !publicAccessKeys.has(key));
  if (unknownKey !== undefined) {
    throw new Error(
      `Clerk error: ${caller} publicAccess has no ${unknownKey} option. It takes any of ${[...publicAccessKeys].join(', ')}`,
    );
  }

  const { methods, tools, resources, prompts } = publicAccess as Record<
    keyof PublicAccess,
    unknown
  >;
  if (methods !== undefined && typeof methods !== 'boolean') {
    if (!Array.isArray(methods)) {
      throw new Error(
        `Clerk error: ${caller} publicAccess.methods must be true or a list of methods, such as ['initialize', 'tools/list']`,
      );
    }
    for (const method of methods) {
      if (typeof method === 'string' && Object.hasOwn(callMethodHints, method)) {
        throw new Error(
          `Clerk error: ${caller} publicAccess.methods cannot list ${method}. To open it without a token, ${callMethodHints[method]}`,
        );
      }
      if (typeof method !== 'string' || !publicMethods.has(method)) {
        throw new Error(
          `Clerk error: ${caller} publicAccess.methods cannot list ${JSON.stringify(method)}. It takes true or any of ${[...publicMethods].join(', ')}`,
        );
      }
    }
  }
  if (tools !== undefined && !isNameList(tools)) {
    throw new Error(
      `Clerk error: ${caller} publicAccess.tools must be a list of tool names, such as ['search_docs']`,
    );
  }
  for (const [key, value, example] of [
    ['resources', resources, "resource URIs, such as ['docs://index']"],
    ['prompts', prompts, "prompt names, such as ['summarize']"],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean' && !isNameList(value)) {
      throw new Error(
        `Clerk error: ${caller} publicAccess.${key} must be true, false, or a list of ${example}`,
      );
    }
  }
}

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === 'string' && name !== '');
}

// Whether a `true`-or-list option opens a call for `value`, the resource URI or prompt name the call asks for
function opensNamed(option: boolean | readonly string[] | undefined, value: unknown): boolean {
  if (option === true) return true;
  return typeof value === 'string' && Array.isArray(option) && option.includes(value);
}

function opensMethod({ methods }: PublicAccess, method: McpPublicMethod): boolean {
  return methods === true || (Array.isArray(methods) && methods.includes(method));
}

// Whether the handshake of either protocol revision is open, which is what lets a client go on without a token
function opensHandshake(publicAccess: PublicAccess): boolean {
  return opensMethod(publicAccess, 'initialize') || opensMethod(publicAccess, 'server/discover');
}

// Whether `publicAccess` opens anything at all, so that a client without a token can have a request in flight
function opensAnything({ methods, tools, resources, prompts }: PublicAccess): boolean {
  return [methods, tools, resources, prompts].some(
    (option) => option === true || (Array.isArray(option) && option.length > 0),
  );
}

// The notifications a client sends about work already under way, which pass whenever `publicAccess` opens anything.
// A challenge for one would start authorization although the user reached nothing protected: `cancelled` when a call
// is cancelled or times out, `progress` while the client answers a request from the server, and
// `roots/list_changed` when the client's roots change. None of them runs anything or returns data, and a server
// ignores a cancellation or progress token for a request it does not have in flight.
const openNotifications: ReadonlySet<string> = new Set([
  'notifications/cancelled',
  'notifications/progress',
  'notifications/roots/list_changed',
]);

// Whether one JSON-RPC message is open without a token. A response to a server request has no `method`, and a
// notification that is not named here is not listed, so both stay closed.
function isPublicMessage(publicAccess: PublicAccess, message: unknown): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (typeof method !== 'string') return false;

  const param = (key: string): unknown =>
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)[key]
      : undefined;

  switch (method) {
    case 'tools/call': {
      const name = param('name');
      return typeof name === 'string' && (publicAccess.tools ?? []).includes(name);
    }
    case 'resources/read':
      return opensNamed(publicAccess.resources, param('uri'));
    case 'prompts/get':
      return opensNamed(publicAccess.prompts, param('name'));
    // The client sends this right after `initialize` succeeds, so it is part of that handshake
    case 'notifications/initialized':
      return opensMethod(publicAccess, 'initialize');
    // From 2026-07-28 this replaces the GET stream, so it opens with the handshake as that GET's 405 does. It also
    // replaces `resources/subscribe`, so every resource it subscribes to must be open.
    case 'subscriptions/listen': {
      const notifications = param('notifications');
      if (
        !opensHandshake(publicAccess) ||
        typeof notifications !== 'object' ||
        notifications === null ||
        Array.isArray(notifications)
      ) {
        return false;
      }
      const uris = (notifications as { resourceSubscriptions?: unknown }).resourceSubscriptions;
      return (
        uris === undefined ||
        (Array.isArray(uris) && uris.every((uri) => opensNamed(publicAccess.resources, uri)))
      );
    }
    default:
      if (openNotifications.has(method)) return opensAnything(publicAccess);
      return publicMethods.has(method) && opensMethod(publicAccess, method as McpPublicMethod);
  }
}

// Whether `publicAccess` opens a parsed request body without a token: one JSON-RPC message, or a batch with at least
// one, where every message is open. One protected message closes the whole batch, since the response to a batch cannot
// be a challenge for part of it.
function isPublicRequest(publicAccess: PublicAccess, body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.length > 0 && messages.every((message) => isPublicMessage(publicAccess, message));
}

/**
 * Reads the JSON body of a request without consuming it, for the `publicAccess` check, so that the MCP transport can
 * still read the request afterwards. It reads a clone, and stops at `PUBLIC_BODY_LIMIT` bytes. Only a body sent as
 * `application/json` is read, the one media type the streamable HTTP transport takes a POST in, which is also what
 * `express.json()` parses for the Express adapter.
 * @param request - The incoming request
 * @returns The parsed body, or `undefined` when there is none, it is over the limit, or it is not JSON. It throws a
 * `Clerk error:` when the body was already read: a request can't be cloned after that, and answering with the 401
 * would give nothing to say why, as with the Express adapter without `express.json()`.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const [mediaType = ''] = (request.headers.get('content-type') ?? '').split(';');
  if (mediaType.trim().toLowerCase() !== 'application/json') return undefined;
  if (request.bodyUsed) {
    throw new Error(
      'Clerk error: publicAccess reads the body of the request, and something before the auth check already read it. Read a copy there instead, as request.clone().json()',
    );
  }
  // `Number(null)` is 0, so a request without the header goes on to the counted read below
  if (Number(request.headers.get('content-length')) > PUBLIC_BODY_LIMIT) return undefined;
  const reader = request.clone().body?.getReader();
  if (!reader) return undefined;

  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PUBLIC_BODY_LIMIT) {
      // Not awaited: cancelling one half of a cloned body only settles once the other half is cancelled as well,
      // and that half belongs to the request the challenge is about to answer
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }

  try {
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    return undefined;
  }
}

/**
 * Throws a `Clerk error:` message for unknown option keys, a non-function `verifyToken`, both `clerkClient` and
 * `verifyToken`, or options that cannot produce a valid challenge: a `requiredScopes` or `challengeScopes` entry that
 * is not an RFC 6749 section
 * 3.3 scope-token, or a `resourceUrl` that is not one absolute http or https URL per origin, without credentials
 * or a fragment.
 * @param caller - The entry point named in the message, such as `mcpAuth`
 * @param options - The entry point's options
 * @param adapterOptionKeys - Keys only this adapter declares, such as Next.js's `onAuthFailure`
 */
export function assertMcpAuthOptions(
  caller: string,
  options: BaseAuthOptions | undefined,
  adapterOptionKeys: ReadonlySet<string> = new Set(),
) {
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new Error(`Clerk error: ${caller} takes an options object`);
    }
    const unknownKey = Object.keys(options).find(
      (key) => !mcpAuthOptionKeys.has(key) && !adapterOptionKeys.has(key),
    );
    if (unknownKey !== undefined) {
      throw new Error(
        `Clerk error: ${caller} has no ${unknownKey} option. It takes any of ${[...mcpAuthOptionKeys, ...adapterOptionKeys].join(', ')}`,
      );
    }
    const { clerkClient, verifyToken } = options as {
      clerkClient?: unknown;
      verifyToken?: unknown;
    };
    if (verifyToken !== undefined && typeof verifyToken !== 'function') {
      throw new Error(`Clerk error: ${caller} verifyToken must be a function`);
    }
    if (clerkClient !== undefined && verifyToken !== undefined) {
      throw new Error(
        `Clerk error: ${caller} cannot set both clerkClient and verifyToken. Choose Clerk verification with clerkClient and resourceUrl, or your own verifyToken`,
      );
    }
  }
  assertScopeTokens(caller, 'requiredScopes', options?.requiredScopes ?? []);
  assertScopeTokens(caller, 'challengeScopes', options?.challengeScopes ?? []);
  if (options?.resourceUrl !== undefined) assertResourceUrls(caller, options.resourceUrl);
  assertPublicAccess(caller, options?.publicAccess);
}

/**
 * Throws a `Clerk error:` message unless `options` is `undefined` or an object with only the keys of the adapter's
 * `mcpAuth` options and `properties`, then checks `resourceUrl` and the scopes as `mcpAuth` does, that `properties`
 * does not set `resource`, and that an explicit `properties.scopes_supported` is an array of strings listing every required and challenge scope. The handler took
 * the additional metadata itself before it took options, so code written for that form, such as
 * `protectedResourceMetadataHandler({ scopes_supported })`, fails at startup with a message naming the new form
 * instead of serving metadata without it.
 * @param options - The handler's options
 * @param adapterOptionKeys - The keys only this adapter's `McpAuthOptions` declare, such as Next.js's `onAuthFailure`
 */
export function assertProtectedResourceMetadataOptions(
  options: unknown,
  adapterOptionKeys: ReadonlySet<string> = new Set(),
) {
  if (options === undefined) return;
  const isOptions =
    typeof options === 'object' &&
    options !== null &&
    !Array.isArray(options) &&
    Object.keys(options).every(
      (key) => protectedResourceMetadataOptionKeys.has(key) || adapterOptionKeys.has(key),
    );
  if (!isOptions) {
    throw new Error(
      "Clerk error: protectedResourceMetadataHandler takes an options object with resourceUrl and properties. Pass the options you give mcpAuth or withClerkMcpAuth, and any other metadata in properties, as protectedResourceMetadataHandler({ resourceUrl: 'https://mcp.example.com/mcp', properties: { resource_name: 'Example' } })",
    );
  }
  const { properties, ...authOptions } = options as ProtectedResourceMetadataOptions;
  assertMcpAuthOptions('protectedResourceMetadataHandler', authOptions, adapterOptionKeys);
  assertPropertiesOmitResource('protectedResourceMetadataHandler', properties);

  const listed = properties?.scopes_supported;
  if (listed === undefined) return;
  if (!Array.isArray(listed) || !listed.every((scope) => typeof scope === 'string')) {
    throw new Error(
      'Clerk error: protectedResourceMetadataHandler properties.scopes_supported must be an array of strings, or left out to list requiredScopes and challengeScopes automatically',
    );
  }
  const missing = requestedScopes(authOptions).filter((scope) => !listed.includes(scope));
  if (missing.length > 0) {
    throw new Error(
      `Clerk error: protectedResourceMetadataHandler properties.scopes_supported leaves out ${missing.join(', ')}, which requiredScopes or challengeScopes lists. Add them to scopes_supported, or leave scopes_supported out to list requiredScopes and challengeScopes automatically`,
    );
  }
}

// `requiredScopes` then `challengeScopes`, each once: the scopes a token for this resource is requested with. The 401
// challenge's `scope` and the metadata's `scopes_supported` both come from here, so the two can't drift apart.
function requestedScopes({ requiredScopes = [], challengeScopes = [] }: BaseAuthOptions): string[] {
  return [...new Set([...requiredScopes, ...challengeScopes])];
}

/**
 * Throws a `Clerk error:` message unless `options` is an options object that can verify tokens, then checks it as
 * `assertMcpAuthOptions` does. `mcpAuth` took a verifier function first before it took options alone, so code written
 * for that form fails at startup with a message naming the new form. Code that passes
 * `mcpAuth` straight to a route has the framework call it with the request where the options belong, which has no
 * `resourceUrl`, so that fails on the first request instead of hanging.
 */
export function assertMiddlewareAuthOptions(options: unknown) {
  if (typeof options === 'function') {
    throw new Error(
      `Clerk error: mcpAuth takes an options object, not a verifier function. Call it as mcpAuth({ verifyToken }) to verify tokens with your own function, or as mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp' }) to verify them with Clerk`,
    );
  }
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: mcpAuth needs a resourceUrl to verify tokens with Clerk. Call it as mcpAuth({ resourceUrl: 'https://mcp.example.com/mcp' }), or as mcpAuth({ verifyToken }) with your own verifier, instead of passing mcpAuth to the route directly`,
  );
  assertMcpAuthOptions('mcpAuth', options as BaseAuthOptions);
}

/**
 * Throws `message` unless `options` has either a `verifyToken` or a `resourceUrl`, the audience Clerk verifies tokens
 * against. Each entry point names its own call forms in `message`.
 * @param options - The entry point's options, unchecked
 * @param message - The error message, starting with `Clerk error:`
 */
export function assertVerifierOrResourceUrl(options: unknown, message: string) {
  const { verifyToken, resourceUrl } = (options ?? {}) as {
    verifyToken?: unknown;
    resourceUrl?: unknown;
  };
  if (verifyToken === undefined && typeof resourceUrl !== 'string' && !Array.isArray(resourceUrl)) {
    throw new Error(message);
  }
}

/**
 * The auth check of an adapter's entry point. `clerkClient` is checked at startup. Each request resolves its token
 * verifier first, the Clerk client before any token is read, so a missing client throws as it is, then is checked.
 * @param caller - The entry point named in the message, such as `mcpAuth`
 * @param options - The entry point's options, already checked
 * @param defaultClient - Returns the adapter's default client for a request, used without `clerkClient`
 * @param defaultName - The default client, as the message names it, such as `clerkClient from '@clerk/express'`
 * @returns The check, resolving to the `bearerAuthenticator` result, or to `serverError` when the token could not
 * be verified at all
 */
export function createBearerAuth<Req>(
  caller: string,
  options: MiddlewareAuthOptions<Req>,
  defaultClient: (request: Req) => Promise<ClerkOAuthClient>,
  defaultName: string,
) {
  function assertClient(client: unknown): asserts client is ClerkOAuthClient {
    if (typeof (client as Partial<ClerkOAuthClient> | null)?.authenticateRequest !== 'function') {
      throw new Error(
        `Clerk error: ${caller} takes a clerkClient with authenticateRequest, or a function that returns one. Omit clerkClient to use ${defaultName}`,
      );
    }
  }

  const { clerkClient } = options as { clerkClient?: unknown };
  let clientFor = defaultClient;
  if (typeof clerkClient === 'function') {
    clientFor = async () => (clerkClient as () => ClerkOAuthClient | Promise<ClerkOAuthClient>)();
  } else if (clerkClient !== undefined) {
    assertClient(clerkClient);
    clientFor = async () => clerkClient;
  }
  const authenticate = bearerAuthenticator(options);
  let warnedAudienceRejection = false;

  return async (
    request: Req,
    input: Omit<BearerRequest, 'verifyToken'>,
  ): Promise<BearerResult | { ok: false; serverError: McpAuthError }> => {
    const custom = options.verifyToken;
    // The Clerk branch always has a `resourceUrl`, so a resource was matched, or the request answered with a 421,
    // before a token is verified
    const client = custom ? undefined : await clientFor(request);
    if (!custom) assertClient(client);
    const verifyToken: TokenVerifier = custom
      ? (token) => custom(token, request)
      : async (token, resource) => {
          try {
            return await verifyClerkOAuthToken(client!, token, resource!);
          } catch (error) {
            if (
              !warnedAudienceRejection &&
              error instanceof McpTokenVerificationError &&
              error.code === 'token-verification-failed' &&
              /^(?:OAuth audience mismatch\.|Invalid (?:OAuth|JWT) audience claim(?: array)? \(aud\))/.test(
                error.message,
              )
            ) {
              warnedAudienceRejection = true;
              // Do not log Clerk's message: it can contain audiences from the untrusted token.
              console.warn(
                'Clerk warning: an OAuth token was rejected because its aud claim is missing, invalid, or does not match resourceUrl. Add the first MCP server to your instance in the Clerk Dashboard to enable aud, configure the client to send resource matching resourceUrl, and use @clerk/backend 3.19.0 or later (@clerk/express 2.1.70 / @clerk/nextjs 7.9.5 or later).',
              );
            }
            throw error;
          }
        };
    try {
      return await authenticate({ ...input, verifyToken });
    } catch (error) {
      if (!(error instanceof McpAuthError)) throw error;
      return { ok: false, serverError: error };
    }
  };
}

/**
 * The verifier `bearerAuthenticator` calls with a request's token, and the listed `resourceUrl` the request matched,
 * or `undefined` without one.
 */
type TokenVerifier = (
  token: string,
  resource: string | undefined,
) => AuthInfo | undefined | Promise<AuthInfo | undefined>;

/**
 * Throws a `Clerk error:` naming the first of `keys` without a value, which the adapter's default Clerk client needs.
 * The adapters read the values themselves: Next.js only inlines `process.env.NEXT_PUBLIC_*` where it is written out.
 * @param caller - The entry point named in the message, such as `mcpAuth`
 * @param keys - Each environment variable's name and value
 * @returns The same keys, each with a value
 */
export function requireClerkEnvKeys<K extends string>(
  caller: string,
  keys: Record<K, string | undefined>,
): Record<K, string> {
  for (const [name, value] of Object.entries(keys)) {
    if (!value) {
      throw new Error(
        `Clerk error: ${caller} needs the ${name} environment variable or a clerkClient option`,
      );
    }
  }
  return keys as Record<K, string>;
}

// The Frontend API URL of the publishable key a metadata handler read from the app's environment, or an error when it
// is not set or is not a Clerk publishable key. It is checked before any request to Clerk, so a mistyped key throws to
// the framework as a missing one does, instead of being answered as Clerk's failure.
function requirePublishableKey(publishableKey: string | undefined, name: string): string {
  if (!publishableKey) {
    throw new Error(`${name} environment variable is required`);
  }
  try {
    return deriveFapiUrl(publishableKey);
  } catch (error) {
    throw new Error(
      `Clerk error: ${name} is not a Clerk publishable key. Copy it from the API keys page of the Clerk Dashboard`,
      { cause: error },
    );
  }
}

/**
 * Throws a `Clerk error:` message when `authorizationServerMetadataHandler` received arguments. It takes none, so any
 * means it was passed to a route without being called, as 0.9.0's `authServerMetadataHandlerClerk` was, and the
 * framework called it with the request: that would otherwise hang the request in Express and Hono, and get a generic
 * error in Next.js. The factories pass `arguments.length`, not a rest parameter, so their declared signature still
 * takes no arguments.
 * @param argumentCount - The number of arguments the handler factory received
 */
export function assertAuthorizationServerMetadataHandlerCalled(argumentCount: number) {
  if (argumentCount > 0) {
    throw new Error(
      'Clerk error: call authorizationServerMetadataHandler() and pass its result to the route, instead of passing authorizationServerMetadataHandler itself',
    );
  }
}

/**
 * Throws a `Clerk error:` message unless `createServer` is a function and `Transport` a class. Code written when the
 * Express adapter also accepted a shared server object passes that object, and a shared server handles only one
 * request at a time; code written before `streamableHttpHandler` took the SDK transport calls it with the server
 * factory alone. Both would otherwise fail on requests instead of at startup.
 */
export function assertStreamableHttpArgs(
  createServer: unknown,
  Transport: unknown,
  className: string,
  sdkModule: string,
) {
  if (typeof createServer !== 'function') {
    throw new Error(
      `Clerk error: streamableHttpHandler needs a function that returns a new MCP server as its first argument, so each request gets its own server. Call streamableHttpHandler(() => new McpServer(...), ${className}) instead of passing a server object`,
    );
  }
  if (typeof Transport !== 'function') {
    throw new Error(
      `Clerk error: streamableHttpHandler needs the MCP SDK transport class as its second argument. Import ${className} from '@modelcontextprotocol/sdk/server/${sdkModule}' and call streamableHttpHandler(createServer, ${className})`,
    );
  }
}

/**
 * The JSON answer to a request whose token Clerk or `verifyToken` could not verify at all, such as during an outage or
 * with an invalid secret key. It is a server error, not a challenge, so the client keeps a token that may be valid. The
 * status is the `McpAuthError`'s `status` when it has one, the 429 or 5xx Clerk's Backend API answered with, otherwise
 * 500. The error is logged with `console.error`, since the framework's error handler never sees it.
 */
export function serverErrorAnswer(error: McpAuthError) {
  console.error(error);
  return { status: error.status ?? 500, body: { error: 'server_error' } } as const;
}

// The headers of a metadata handler's successful response in every adapter: an hour of caching, and the CORS headers
// that let a browser-based MCP client read the metadata from any origin. An error answer gets `metadataCorsHeaders`
// alone, so it is readable but not cached.
const metadataResponseHeaders = {
  'Cache-Control': 'max-age=3600',
  'Content-Type': 'application/json',
  ...metadataCorsHeaders,
};

/**
 * The answer `streamableHttpHandler` gives a request that isn't a POST. It serves each POST on a new stateless
 * transport, so it has no session for a GET to stream on or a DELETE to end. It answers both with the 405 and JSON-RPC
 * error that MCP SDK 2's stateless serving sends, rather than letting an SDK 1 transport open a stream that nothing
 * will ever write to.
 */
export const methodNotAllowed = {
  status: 405,
  headers: { Allow: 'POST' },
  body: { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
} as const;

/**
 * The RFC 9728 section 3 metadata URL for a resource: the well-known path goes between the host and the resource's
 * path and query.
 */
export function resourceMetadataUrlFor(resourceUrl: string): string {
  const { origin, pathname, search } = new URL(resourceUrl);
  return `${origin}/.well-known/oauth-protected-resource${pathname === '/' ? '' : pathname}${search}`;
}

// The resource a protected resource metadata URL describes, the inverse of `resourceMetadataUrlFor`: the well-known
// path is removed and the rest of the path and the query are kept as they are, so
// `/.well-known/oauth-protected-resource/mcp/` describes `<origin>/mcp/` and the root describes the bare origin. RFC
// 9728 section 3.3 has clients discard metadata whose `resource` is not identical to the URL they derived it from.
function resourceFromMetadataUrl(metadataUrl: string): string {
  const { origin, pathname, search } = new URL(metadataUrl);
  return `${origin}${pathname.replace('/.well-known/oauth-protected-resource', '')}${search}`;
}

/**
 * The status, headers, and JSON body a metadata handler sends.
 */
export type MetadataAnswer = {
  status: 200 | 400 | 421 | 502;
  headers: Record<string, string>;
  body: unknown;
};

/**
 * A metadata request, as the adapter reads it: the publishable key from the app's environment, with the variable's
 * name for the error when it is missing or invalid, which is thrown to the framework.
 */
type MetadataRequest = {
  publishableKey: string | undefined;
  keyName?: string | undefined;
};

/**
 * The answer every `protectedResourceMetadataHandler` gives a request: the metadata with `metadataResponseHeaders`,
 * or with `metadataCorsHeaders` alone a 400 for a request without a URL, or a 421 for an origin no listed
 * `resourceUrl` has (RFC 9110 section 15.5.20), as `mcpAuth` answers it. The `resource` is the `resourceUrl` for the
 * request, the URL `mcpAuth` checks, or without `resourceUrl` the resource the requested metadata URL describes, so it
 * is identical to the URL the client derived the metadata URL from (RFC 9728 section 3.3). `scopes_supported` (RFC
 * 9728 section 2) lists `requiredScopes` then `challengeScopes`, each once, unless `properties` sets it, and is left
 * out without scopes.
 * @param options - The handler's options, already checked
 * @param request - The request, with `url`, the URL the metadata was requested at, `undefined` when it has none
 */
export function protectedResourceMetadataAnswer(
  { resourceUrl, requiredScopes, challengeScopes, properties }: ProtectedResourceMetadataOptions,
  {
    publishableKey,
    keyName = 'CLERK_PUBLISHABLE_KEY',
    url,
  }: MetadataRequest & {
    url: string | undefined;
  },
): MetadataAnswer {
  const authServerUrl = requirePublishableKey(publishableKey, keyName);
  if (url === undefined) {
    return { status: 400, headers: metadataCorsHeaders, body: { error: 'invalid_request' } };
  }
  const resource =
    resourceUrl === undefined ? resourceFromMetadataUrl(url) : matchResourceUrl(resourceUrl, url);
  if (resource === undefined) {
    return { status: 421, headers: metadataCorsHeaders, body: { error: 'misdirected_request' } };
  }
  // A `scopes_supported` key set to `undefined` is treated as left out, so it does not erase the derived list
  const derived = requestedScopes({ requiredScopes, challengeScopes });
  const scopes = properties?.scopes_supported ?? (derived.length > 0 ? derived : undefined);
  const metadata = generateProtectedResourceMetadata({
    authServerUrl,
    resourceUrl: resource,
    properties: scopes === undefined ? properties : { ...properties, scopes_supported: scopes },
  });
  return { status: 200, headers: metadataResponseHeaders, body: metadata };
}

/**
 * The answer every `authorizationServerMetadataHandler` gives a request: Clerk's metadata with
 * `metadataResponseHeaders`, or a 502 with `metadataCorsHeaders` alone when it can't be fetched (RFC 9110 section
 * 15.6.3): the handler relays the metadata of an upstream server, Clerk's Frontend API, which failed. That error is
 * logged with `console.error`, since the framework's error handler never sees it.
 * @param request - The request
 */
export async function authorizationServerMetadataAnswer({
  publishableKey,
  keyName = 'CLERK_PUBLISHABLE_KEY',
}: MetadataRequest): Promise<MetadataAnswer> {
  requirePublishableKey(publishableKey, keyName);
  try {
    const metadata = await fetchAuthorizationServerMetadata({
      publishableKey: publishableKey as string,
    });
    return { status: 200, headers: metadataResponseHeaders, body: metadata };
  } catch (error) {
    console.error(error);
    return { status: 502, headers: metadataCorsHeaders, body: { error: 'server_error' } };
  }
}

// An RFC 9110 `auth-param` value here is a `quoted-string`: a URL's `:` and `/` are not allowed in a bare token.
function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function bearerChallenge({
  resourceMetadataUrl,
  error,
  scopes,
}: {
  resourceMetadataUrl: string;
  error?: 'invalid_token' | 'insufficient_scope';
  scopes?: readonly string[];
}): string {
  const params = [`resource_metadata=${quoted(resourceMetadataUrl)}`];
  if (error) params.push(`error=${quoted(error)}`);
  if (scopes && scopes.length > 0) params.push(`scope=${quoted(scopes.join(' '))}`);
  return `Bearer ${params.join(', ')}`;
}

type ParsedAuthorization = { token: string } | { reason: 'missing_token' | 'malformed_token' };

// The token from a well-formed `Bearer <token>` header. The scheme is case-insensitive. A header with another scheme,
// such as `Basic`, gets the challenge without an error code, as RFC 6750 section 3.1 says for a request that "attempted
// using an unsupported authentication method". Only malformed Bearer credentials, such as `Bearer a b` or two
// `Authorization` headers joined into one, depart from that section: its `invalid_request` SHOULD get a 400 for a
// request that is "otherwise malformed", and these get the same 401 challenge as a missing header instead, so that a
// client sending an empty or broken token can still start authorization.
function parseAuthorization(header: string | undefined): ParsedAuthorization {
  if (!header?.trim()) return { reason: 'missing_token' };
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    return { reason: 'malformed_token' };
  }
  return { token };
}

// The RFC 9728 metadata URL for the request's own path, used when `resourceUrl` is not set. The request's query is
// left out: it belongs to the request, not to the resource.
function requestResourceMetadataUrl(requestUrl: string): string {
  const { origin, pathname } = new URL(requestUrl);
  return resourceMetadataUrlFor(`${origin}${pathname}`);
}

/**
 * One request to `bearerAuthenticator`'s check.
 */
type BearerRequest = {
  authorization: string | undefined;
  /**
   * The URL the request was made to, used to pick a listed `resourceUrl`, or to derive one when it is not set.
   * `undefined` when the request has none, which gets a 400.
   */
  requestUrl: string | undefined;
  /**
   * The request's HTTP method, which `publicAccess` needs: only a POST carries JSON-RPC messages.
   */
  method?: string | undefined;
  /**
   * Returns the request's parsed JSON body, or `undefined` when it cannot be read. It is called at most once, and
   * only for a POST without a token when `publicAccess` is set.
   */
  body?: (() => unknown) | undefined;
  verifyToken: TokenVerifier;
};

/**
 * The response rule the adapters share, for one set of options:
 *
 * 1. With a list of `resourceUrl`s, a request to an origin none of them has gets a 421 without a challenge, before the
 *    token is read, since a token is issued for one resource (the 421 is this package's answer, not an RFC 8707 rule).
 *    Otherwise it uses the listed URL with its origin.
 * 2. With `publicAccess`, a request without an `Authorization` header can pass with `authInfo` `undefined`: a POST
 *    whose every JSON-RPC message is open. A GET gets a 405 when the handshake is public, the transport
 *    specification's answer for "no stream", since a 401 there would make the client sign in before it reached
 *    anything protected.
 * 3. A missing or malformed header gets a 401 challenge without an error code, and a rejected token adds
 *    `error="invalid_token"` (RFC 6750 section 3). Both list `requiredScopes` then `challengeScopes` in `scope`. A
 *    verifier that throws an `McpTokenVerificationError` rejects the token, with it as the failure's `cause`; any
 *    other error it throws is wrapped in an `McpAuthError`. As in MCP SDK 2's `verifyBearerToken`, a token whose
 *    auth info reports another `resource` than the listed URL is rejected.
 * 4. A token without `requiredScopes` gets a 403 `insufficient_scope` (RFC 6750 section 3.1) that lists the granted
 *    scopes then every missing `requiredScopes` and `challengeScopes` entry, as `requireAdditionalScopes` does. A
 *    token that lacks only `challengeScopes` entries passes, and its auth info gets `resourceMetadataUrl`, which MCP
 *    SDK 2 puts in its own scope challenges.
 * @param options - The entry point's options, already checked
 * @returns The check for one request
 */
export function bearerAuthenticator({
  resourceUrl,
  requiredScopes = [],
  challengeScopes: extraChallengeScopes = [],
  publicAccess,
}: Pick<BaseAuthOptions, 'resourceUrl' | 'requiredScopes' | 'challengeScopes' | 'publicAccess'>) {
  const unauthorizedScopes = requestedScopes({
    requiredScopes,
    challengeScopes: extraChallengeScopes,
  });
  return async ({
    authorization,
    requestUrl,
    method,
    body,
    verifyToken,
  }: BearerRequest): Promise<BearerResult> => {
    // A missing `Host` header, or one that does not parse, would otherwise throw below and reach the app as a server
    // error, or derive a challenge for `http://undefined`
    if (requestUrl === undefined) {
      return {
        ok: false,
        failure: undefined,
        status: 400,
        headers: {},
        body: { error: 'invalid_request' },
      };
    }
    let resourceMetadataUrl: string;
    // The resource a token must be for, when `resourceUrl` names it. A URL derived from the request is not checked:
    // it can be an internal URL that no token names.
    let expectedResource: string | undefined;
    if (resourceUrl === undefined) {
      resourceMetadataUrl = requestResourceMetadataUrl(requestUrl);
    } else {
      const matched = matchResourceUrl(resourceUrl, requestUrl);
      if (!matched) return fail({ reason: 'misdirected_request' }, 421, 'misdirected_request');
      resourceMetadataUrl = resourceMetadataUrlFor(matched);
      expectedResource = matched;
    }

    const parsed = parseAuthorization(authorization);
    // Only a request without an `Authorization` header, or with an empty one, can be public. A malformed header is a
    // failed attempt to authenticate.
    if ('reason' in parsed && parsed.reason === 'missing_token' && publicAccess) {
      const httpMethod = method?.toUpperCase();
      if (httpMethod === 'POST' && isPublicRequest(publicAccess, await body?.())) {
        return { ok: true, authInfo: undefined };
      }
      if (httpMethod === 'GET' && opensHandshake(publicAccess)) {
        return { ok: false, failure: undefined, ...methodNotAllowed };
      }
    }
    if ('reason' in parsed) {
      return fail(
        { reason: parsed.reason },
        401,
        'Unauthorized',
        bearerChallenge({ resourceMetadataUrl, scopes: unauthorizedScopes }),
      );
    }

    let authInfo: AuthInfo | undefined;
    let rejection: McpTokenVerificationError | undefined;
    try {
      authInfo = await verifyToken(parsed.token, expectedResource);
    } catch (error) {
      if (!(error instanceof McpTokenVerificationError)) {
        throw error instanceof McpAuthError ? error : new McpAuthError(error);
      }
      rejection = error;
    }

    // An expired token gets `invalid_token` (RFC 6750 section 3.1): a `verifyToken` can return the auth info of a
    // token it decoded or cached.
    if (
      authInfo?.expiresAt !== undefined &&
      Number.isFinite(authInfo.expiresAt) &&
      authInfo.expiresAt <= Date.now() / 1000
    ) {
      const expiry = new Date(authInfo.expiresAt * 1000);
      rejection = new McpTokenVerificationError(
        'token-expired',
        Number.isFinite(expiry.getTime())
          ? `The token expired at ${expiry.toISOString()}`
          : `The token has no valid expiry time (${authInfo.expiresAt})`,
      );
      authInfo = undefined;
    }

    // OAuth 2.1 section 5.2, which MCP authorization 2025-06-18 and later points to: the resource server MUST check
    // that the token is not expired, which a result without an expiry, or with one that is not a finite number such as
    // `NaN`, can't show. Clerk enforces `exp` itself, so its auth info may leave `expiresAt` out.
    const missingClaim = authInfo && missingClaimMessage(authInfo);
    if (missingClaim) {
      rejection = new McpTokenVerificationError('token-claims-missing', missingClaim);
      authInfo = undefined;
    }

    // RFC 8707 section 3: "An audience-restricted access token that is legitimately presented to a resource cannot
    // then be taken by that resource and presented elsewhere". A verifier that reports the token's resource has done
    // the audience lookup, so a token it reports for another resource is `invalid_token` (RFC 6750 section 3.1).
    // Clerk verification checks `aud` itself and leaves `resource` unset.
    if (
      authInfo?.resource !== undefined &&
      expectedResource !== undefined &&
      !isSameResource(authInfo.resource, expectedResource)
    ) {
      rejection = new McpTokenVerificationError(
        'resource-mismatch',
        `The token was issued for ${String(authInfo.resource)}, not ${expectedResource}`,
      );
      authInfo = undefined;
    }

    if (!authInfo) {
      return fail(
        { reason: 'invalid_token', ...(rejection && { cause: rejection }) },
        401,
        'Unauthorized',
        bearerChallenge({
          resourceMetadataUrl,
          error: 'invalid_token',
          scopes: unauthorizedScopes,
        }),
      );
    }

    // Only a missing `requiredScopes` entry gets the 403, and it also asks for the missing `challengeScopes`, so a
    // client that reauthorizes with its `scope` gets every tool's scopes at once
    const scopes = challengeScopes(requiredScopes, authInfo, unauthorizedScopes);
    if (scopes) {
      return fail(
        { reason: 'insufficient_scope' },
        403,
        'insufficient_scope',
        bearerChallenge({ resourceMetadataUrl, error: 'insufficient_scope', scopes }),
      );
    }

    // MCP SDK 2 reads `resourceMetadataUrl` from the auth info for the challenges its `scopeChallenge` tools send
    return {
      ok: true,
      authInfo: copyClerkVerification(authInfo, { ...authInfo, resourceMetadataUrl }),
    };
  };
}

// Why a verifier's result lacks a claim the token must have, or `undefined` when it has them all. The wording follows
// MCP SDK's `requireBearerAuth` ("Token has no expiration time"), naming the field.
function missingClaimMessage(authInfo: AuthInfo): string | undefined {
  const { expiresAt } = authInfo;
  if (expiresAt !== undefined && !Number.isFinite(expiresAt)) {
    return `Token has no valid expiration time (expiresAt: ${expiresAt})`;
  }
  if (isClerkAuthInfo(authInfo)) return undefined;
  if (expiresAt === undefined) return 'Token has no expiration time (expiresAt)';
  // RFC 9068 section 2.2 makes `client_id` REQUIRED in a JWT access token, and Clerk rejects a token without one
  if (typeof authInfo.clientId !== 'string' || authInfo.clientId === '') {
    return 'Token has no client ID (clientId)';
  }
  return undefined;
}

function fail(
  failure: McpAuthFailure,
  status: 401 | 403 | 421,
  error: string,
  challenge?: string,
): BearerResult {
  return {
    ok: false,
    failure,
    status,
    headers: challenge ? { 'WWW-Authenticate': challenge } : {},
    body: { error },
  };
}

// Whether a verifier's reported `resource` is the expected resource URL. It mirrors `sameResource` in MCP SDK 2's
// `verifyBearerToken`, which ignores a fragment and a trailing slash, so `https://mcp.example.com/` matches the bare
// origin as `verifyClerkOAuthToken` accepts it. Both sides are normalized as URLs first, so a configured
// `resourceUrl` that differs from the reported `URL` only in letter case or a default port still matches.
function isSameResource(reported: URL | string, expected: string): boolean {
  const comparable = (value: URL | string) => {
    const text = URL.canParse(value) ? new URL(value).href : String(value);
    const hash = text.indexOf('#');
    return (hash === -1 ? text : text.slice(0, hash)).replace(/\/$/, '');
  };
  return comparable(reported) === comparable(expected);
}

// The reasons Clerk gives when it could not verify a token at all, such as during an outage or with an invalid secret
// key, as opposed to when it rejected the token. `jwk-remote-failed-to-load` is the reason clerk/javascript#10826 has
// `@clerk/backend` give a JWT access token whose JWKS can't be loaded; no release declares it yet, so the element type
// is widened to take it.
const verificationUnavailable: ReadonlySet<string> = new Set<
  MachineTokenVerificationErrorCode | 'jwk-remote-failed-to-load'
>(['unexpected-error', 'secret-key-invalid', 'jwk-remote-failed-to-load']);

// Clerk keeps the Backend API's status only in the message, as `Unexpected error (code=unexpected-error, status=503)`,
// the form of `MachineTokenVerificationError.getFullMessage()` in `@clerk/backend`.
function clerkStatus(message: string | undefined): number | undefined {
  const status = /\(code=[^,()]*, status=(\d{3})\)$/.exec(message ?? '')?.[1];
  return status === undefined ? undefined : Number(status);
}

// Whether Clerk could not verify the token at all, so the client must keep it. A Backend API 4xx other than 401 (an
// invalid secret key) and 429 (rate limiting) is Clerk refusing the token. Until clerk/javascript#10826 reports a JWKS
// that can't be loaded as `jwk-remote-failed-to-load`, `@clerk/backend` gives it the reason an invalid signature
// gets, keeping the message `fetchJWKSFromBAPI` throws, so only that message's prefix tells the two apart. Drop the
// prefix rule once the supported backend floor reports the reason.
function isVerificationUnavailable(reason: string, message: string, status: number | undefined) {
  if (reason === 'token-verification-failed') return message.startsWith('Error loading Clerk JWKS');
  if (!verificationUnavailable.has(reason)) return false;
  return status === undefined || status < 400 || status >= 500 || status === 401 || status === 429;
}

/**
 * Verifies an OAuth access token with Clerk, requiring `audience` in its `aud` claim. A token Clerk rejects throws an
 * `McpTokenVerificationError` with Clerk's reason and message, which reaches the client as an `invalid_token`
 * challenge. When Clerk could not verify the token at all, it throws an `McpAuthError` around that error instead, and
 * the framework answers with a server error, since a challenge would make the client discard a valid token. That covers
 * a Backend API check that failed with a 429, a 5xx, or no response, which the answer keeps as its status (500
 * without one), an invalid secret key, and a JWKS load reported as `jwk-remote-failed-to-load` or with the
 * `Error loading Clerk JWKS` HTTP-error message (see `isVerificationUnavailable`). Released backend versions report
 * a JWKS fetch that throws before a response, such as a DNS or connection failure, as `token-verification-failed`
 * with only the fetch error's message. That case still gets an `invalid_token` challenge until clerk/javascript#10826
 * reports it as `jwk-remote-failed-to-load`; it cannot safely be distinguished from a rejected token by its message.
 */
export async function verifyClerkOAuthToken(
  client: ClerkOAuthClient,
  token: string,
  audience: string,
) {
  // Clerk compares the audience exactly, and a client can send the resource in normalized form, such as
  // `https://mcp.example.com/` for `https://mcp.example.com`, so both forms of the same URL are accepted. For the root
  // the bare origin is accepted too, because that is the `resource` the protected resource metadata describes for it.
  // Clerk builds `aud` from the client's `resource` with only its scheme and host lowercased, which RFC 3986 section
  // 6.2.2.1 makes case-insensitive, but keeps a default port that the normalized form drops (section 6.2.3), so the URL
  // with only its scheme and authority lowercased is accepted as well.
  const url = new URL(audience);
  const [authority = ''] = /^[^/?#]*\/\/[^/?#]*/.exec(audience) ?? [];
  const forms = [audience, url.href, authority.toLowerCase() + audience.slice(authority.length)];
  if (url.pathname === '/' && !url.search) forms.push(url.origin);
  const audiences = [...new Set(forms)];
  const requestState = await client.authenticateRequest(
    new Request(audience, { headers: { authorization: `Bearer ${token}` } }),
    {
      acceptsToken: 'oauth_token',
      audience: audiences.length === 1 ? audience : audiences,
    },
  );
  if (!requestState.isAuthenticated) {
    const { reason, message } = requestState;
    const status = clerkStatus(message);
    // Clerk leaves the message empty for some reasons, such as `token-type-mismatch`
    const error = new McpTokenVerificationError(
      reason,
      message || `Clerk did not accept the token (${reason})`,
      { status },
    );
    if (isVerificationUnavailable(reason, message ?? '', status)) throw new McpAuthError(error);
    throw error;
  }

  const authInfo = toClerkAuthInfo(requestState.toAuth(), token);
  if (!authInfo) {
    throw new McpTokenVerificationError(
      'token-claims-missing',
      'Clerk verified the token, but its auth object has no user ID, client ID, scopes, id, subject, or getToken',
    );
  }
  return authInfo;
}
