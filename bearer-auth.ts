// The bearer-token rules that the Express, Hono, and Next.js adapters share. This module is not a package entry point.
import type { MachineTokenVerificationErrorCode } from '@clerk/backend/errors';
import type { AuthInfo } from './mcp-types';
import { assertPropertiesOmitResource } from './resource-metadata-properties';
import { assertScopeTokens, challengeScopes } from './scope-challenge';
import {
  type ClerkOAuthClient,
  type McpAuthFailure,
  type McpPublicMethod,
  type McpResourceUrl,
  type PublicAccess,
  McpAuthError,
  McpTokenVerificationError,
  generateProtectedResourceMetadata,
  matchResourceUrl,
  toClerkAuthInfo,
} from './server';

/**
 * The options every auth entry point takes, with `resourceUrl` optional as it is for a custom verifier.
 */
export type BaseAuthOptions = {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one
   * for each origin the server answers on. A request uses the listed URL with its origin, and a request to any other
   * origin gets a 421. A single URL is used whatever origin the request has, so it works behind a proxy as it is. Only
   * a list is matched against the request's origin, which is the one the app sees: behind a proxy that terminates TLS
   * or rewrites `Host`, rebuild it from `X-Forwarded-*` headers you trust (in Express, set `trust proxy`). Never list
   * the internal URLs: each listed URL is an audience and a metadata `resource`, and clients connect to the public one.
   * The challenge's `resource_metadata` is derived from it.
   * With `verifyToken` it can be omitted, and it is then derived from the incoming request, which can differ from the
   * public URL behind a proxy. Without `verifyToken` it is required: Clerk rejects a token whose `aud` claim does not
   * include the URL for the request's origin, so a token issued for one listed URL does not pass on another. Pass the
   * same value to `protectedResourceMetadataHandler`, so its `resource` is the URL checked here.
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
 * The options for verifying tokens with Clerk, which needs `resourceUrl` as the audience.
 */
export type ClerkAuthOptions = BaseAuthOptions & {
  /**
   * The exact URL clients use for this MCP endpoint, such as `https://mcp.example.com/mcp`, or a list of them, one
   * for each origin the server answers on. Clerk rejects a token whose `aud` claim does not include the URL for the
   * request's origin, so a token issued for one listed URL does not pass on another, and a request to any other origin
   * gets a 421. The challenge's `resource_metadata` is derived from it. Pass the same value to
   * `protectedResourceMetadataHandler`, so its `resource` is the URL checked here.
   */
  resourceUrl: McpResourceUrl;
};

/**
 * The branch of every adapter's options union that verifies tokens with the caller's function, for the framework's
 * request type `Req`. `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type CustomVerifierAuthOptions<Req> = BaseAuthOptions & {
  /**
   * Verifies a token in place of Clerk and returns its auth info, or `undefined` to reject it. Throw an
   * `McpTokenVerificationError` to reject it with a reason. The token comes first and the request second, the reverse
   * of the verifier `withMcpAuth` from `mcp-handler` takes.
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
 * The `clerkClient` option of every adapter: the Clerk client that verifies tokens, or a function that returns one,
 * which is called once for each request that is checked, such as to read the keys when a request arrives. Create the
 * client with both `secretKey` and `publishableKey`: without a publishable key, every request fails. A client from
 * `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check.
 */
export type ClerkClientOption =
  | ClerkOAuthClient
  | (() => ClerkOAuthClient | Promise<ClerkOAuthClient>);

/**
 * The options of the Express and Hono `mcpAuth` middleware, for the framework's request type `Req`. Without
 * `verifyToken`, Clerk verifies each token, and `resourceUrl` is required as its audience. With `verifyToken`, that
 * function verifies each token instead, `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type MiddlewareAuthOptions<Req> =
  | (ClerkAuthOptions & {
      /**
       * The Clerk client that verifies tokens, or a function that returns one, called once for each request. Create
       * the client with both `secretKey` and `publishableKey`: without a publishable key, every request fails. A
       * client from `@clerk/backend` must be version 3.19.0 or later, the first with a reliable audience check.
       */
      clerkClient?: ClerkClientOption | undefined;
      verifyToken?: never;
    })
  | CustomVerifierAuthOptions<Req>;

/**
 * The options of every adapter's `protectedResourceMetadataHandler`: the adapter's `McpAuthOptions`, all optional,
 * plus `properties`, so one object can be passed to both. The handler reads `resourceUrl`, `requiredScopes`,
 * `challengeScopes`, and `properties`, and ignores the adapter's other `McpAuthOptions` keys: `clerkClient` and
 * `verifyToken` in every adapter, and `onAuthFailure` in Next.js.
 */
export type ProtectedResourceMetadataOptions<
  AuthOptions extends BaseAuthOptions = BaseAuthOptions,
> = Partial<AuthOptions> & {
  /**
   * The `resourceUrl` given to `mcpAuth` or `withMcpAuth` for the endpoint this metadata describes: one URL, or a
   * list with one for each origin. The metadata's `resource` is then the URL they check for the same request,
   * whatever origin the app sees behind a proxy for a single URL, and with a list a request to an origin none of
   * them has gets a 421. Without it, `resource` is derived from the URL the metadata route was requested at, which
   * can differ from the public URL behind a proxy.
   */
  resourceUrl?: McpResourceUrl | undefined;
  /**
   * Additional metadata, such as `resource_name`. It overrides the generated metadata, except `resource`, which it
   * cannot set: that is `resourceUrl`, the URL `mcpAuth` checks (RFC 9728 section 3.3). Without `scopes_supported`,
   * the metadata lists `requiredScopes` then `challengeScopes`, each once. A `scopes_supported` given here is used
   * as is, and must list every one of them.
   */
  properties?: Record<string, unknown> | undefined;
};

// The keys of the `McpAuthOptions` every adapter shares, and `properties`, which the metadata handler accepts so one
// object can be passed to both. An adapter whose options declare more passes those keys to the check itself.
const protectedResourceMetadataOptionKeys: ReadonlySet<string> = new Set<
  keyof ProtectedResourceMetadataOptions<MiddlewareAuthOptions<unknown>>
>([
  'resourceUrl',
  'requiredScopes',
  'challengeScopes',
  'publicAccess',
  'properties',
  'clerkClient',
  'verifyToken',
]);

type BearerResult =
  // `authInfo` is `undefined` for a request without a token that `publicAccess` lets through
  | { ok: true; authInfo: (AuthInfo & { resourceMetadataUrl: string }) | undefined }
  | {
      ok: false;
      failure: McpAuthFailure;
      status: 401 | 403 | 421;
      challenge: string | undefined;
      error: string;
    }
  // A GET without a token on a server whose handshake is public. It is not an auth failure, so it has none.
  | {
      ok: false;
      failure: undefined;
      status: 405;
      challenge: undefined;
      error: 'method_not_allowed';
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
 * In Express, `express.json()` reads the body before `mcpAuth` does, so its `limit` (100kb by default) is what bounds
 * the buffering there; a body whose `Content-Length` is over this limit still gets the 401.
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

/**
 * Whether `publicAccess` opens a request body without a token: one JSON-RPC message, or a batch with at least one,
 * where every message is open. One protected message closes the whole batch, since the response to a batch cannot be
 * a challenge for part of it.
 * @param publicAccess - The `publicAccess` option, already checked
 * @param body - The request's parsed JSON body, or `undefined` when it could not be read
 * @returns Whether the request may pass without auth info
 */
export function isPublicRequest(publicAccess: PublicAccess, body: unknown): boolean {
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

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Throws a `Clerk error:` message when the options cannot produce a valid challenge: a `requiredScopes` or
 * `challengeScopes` entry that is not an RFC 6749 section 3.3 scope-token, or a `resourceUrl` that is not one absolute http or https
 * URL per origin, without credentials or a fragment.
 * @param caller - The entry point named in the message, such as `mcpAuth`
 * @param options - The entry point's options
 */
export function assertMcpAuthOptions(caller: string, options: BaseAuthOptions | undefined) {
  assertScopeTokens(caller, 'requiredScopes', options?.requiredScopes ?? []);
  assertScopeTokens(caller, 'challengeScopes', options?.challengeScopes ?? []);
  if (options?.resourceUrl !== undefined) assertResourceUrls(caller, options.resourceUrl);
  assertPublicAccess(caller, options?.publicAccess);
}

// Each URL is checked once here, so a request only has to find the one with its origin.
function assertResourceUrls(caller: string, resourceUrl: unknown) {
  const urls: unknown = typeof resourceUrl === 'string' ? [resourceUrl] : resourceUrl;
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(`Clerk error: ${caller} resourceUrl must be a URL or a non-empty list of URLs`);
  }

  const origins = new Set<string>();
  for (const url of urls) {
    if (typeof url !== 'string' || !isResourceUrl(url)) {
      throw new Error(
        `Clerk error: ${caller} resourceUrl must be an absolute http or https URL without credentials or a fragment`,
      );
    }
    // The request's origin picks the URL, so two URLs with one origin would leave the choice ambiguous
    const { origin } = new URL(url);
    if (origins.has(origin)) {
      throw new Error(
        `Clerk error: ${caller} resourceUrl lists more than one URL for ${origin}. List one URL for each origin`,
      );
    }
    origins.add(origin);
  }
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
      "Clerk error: protectedResourceMetadataHandler takes an options object with resourceUrl and properties. Pass the options you give mcpAuth or withMcpAuth, and any other metadata in properties, as protectedResourceMetadataHandler({ resourceUrl: 'https://mcp.example.com/mcp', properties: { resource_name: 'Example' } })",
    );
  }
  const { properties, ...authOptions } = options as ProtectedResourceMetadataOptions;
  assertMcpAuthOptions('protectedResourceMetadataHandler', authOptions);
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
 * The protected resource metadata a Clerk instance's `protectedResourceMetadataHandler` serves for a request, or
 * `undefined` when a list of `resourceUrl`s has none with the request's origin, which the adapters answer with a 421,
 * as `mcpAuth` does (RFC 9110 section 15.5.20). The `resource` is the `resourceUrl` for the request, the URL `mcpAuth`
 * checks, or without `resourceUrl` the resource the requested metadata URL describes, so it is identical to the URL
 * the client derived the metadata URL from (RFC 9728 section 3.3). `scopes_supported` (RFC 9728 section 2) lists
 * `requiredScopes` then `challengeScopes`, each once, unless `properties` sets it, and is left out without scopes.
 * @param options - The handler's options, already checked
 * @param metadataUrl - The URL the metadata route was requested at
 * @param publishableKey - The Clerk publishable key
 * @returns The metadata, or `undefined` for a request to an origin no `resourceUrl` lists
 */
export function clerkProtectedResourceMetadata(
  { resourceUrl, requiredScopes, challengeScopes, properties }: ProtectedResourceMetadataOptions,
  metadataUrl: string,
  publishableKey: string,
) {
  const resource =
    resourceUrl === undefined
      ? resourceFromMetadataUrl(metadataUrl)
      : matchResourceUrl(resourceUrl, metadataUrl);
  if (resource === undefined) return undefined;
  // A `scopes_supported` key set to `undefined` is treated as left out, so it does not erase the derived list
  const derived = requestedScopes({ requiredScopes, challengeScopes });
  const scopes = properties?.scopes_supported ?? (derived.length > 0 ? derived : undefined);
  return generateProtectedResourceMetadata({
    publishableKey,
    resourceUrl: resource,
    properties: scopes === undefined ? properties : { ...properties, scopes_supported: scopes },
  });
}

/**
 * The audience for a request that `mcpAuth` let through, which always matches a listed `resourceUrl`, since a request
 * to any other origin gets a 421 first.
 */
export function audienceFor(resourceUrl: McpResourceUrl, requestUrl: string): string {
  const audience = matchResourceUrl(resourceUrl, requestUrl);
  if (!audience) {
    throw new Error(
      `Clerk error: no resourceUrl matches the origin of ${new URL(requestUrl).origin}`,
    );
  }
  return audience;
}

// A URL with another scheme, such as `mailto:`, has no origin for the challenge, `new Request` throws on a URL with
// credentials, and a resource identifier must not have a fragment (RFC 8707 section 2).
function isResourceUrl(value: string): boolean {
  if (!URL.canParse(value) || value.includes('#')) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
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
 * Returns the Clerk client for a request in the Clerk branch of an entry point's options: the `clerkClient` option,
 * checked here, at startup, or the adapter's default without it. A function option is called on each call.
 * @param caller - The entry point named in the message, such as `mcpAuth`
 * @param clerkClient - The `clerkClient` option, unchecked
 * @param defaultClient - Returns the adapter's default client for a request
 * @param defaultName - The default client, as the message names it, such as `clerkClient from '@clerk/express'`
 * @returns A function that resolves the client for a request
 */
export function clerkClientResolver<Req>(
  caller: string,
  clerkClient: unknown,
  defaultClient: (request: Req) => Promise<ClerkOAuthClient>,
  defaultName: string,
): (request: Req) => Promise<ClerkOAuthClient> {
  if (clerkClient === undefined) return defaultClient;
  if (typeof clerkClient === 'function') {
    const resolve = clerkClient as () => ClerkOAuthClient | Promise<ClerkOAuthClient>;
    return async () => resolve();
  }
  if (
    typeof (clerkClient as Partial<ClerkOAuthClient> | null)?.authenticateRequest !== 'function'
  ) {
    throw new Error(
      `Clerk error: ${caller} takes a clerkClient with authenticateRequest, or a function that returns one. Omit clerkClient to use ${defaultName}`,
    );
  }
  const client = clerkClient as ClerkOAuthClient;
  return async () => client;
}

/**
 * The token verifier for one request, made once the request arrives. With `verifyToken`, it calls that with the token
 * and the request. Otherwise the Clerk client is resolved here, once for the request and before any token is read,
 * so a missing client is thrown as it is, on a request with or without a token; thrown by the verifier, it would be
 * the `cause` of an `McpAuthError`, and only once a token arrived. Each token is then verified with that client, with
 * the listed `resourceUrl` for the request's origin as the audience.
 * @param options - The entry point's options
 * @param clientFor - Returns the Clerk client for a request, from `clerkClientResolver`
 * @param request - The framework's request or context
 * @param requestUrlOf - Returns the URL the request was made to
 * @returns A verifier that takes the token
 */
export async function requestTokenVerifier<Req>(
  options: MiddlewareAuthOptions<Req>,
  clientFor: (request: Req) => Promise<ClerkOAuthClient>,
  request: Req,
  requestUrlOf: (request: Req) => string,
): Promise<(token: string) => AuthInfo | undefined | Promise<AuthInfo | undefined>> {
  if (options.verifyToken) {
    const custom = options.verifyToken;
    return (token) => custom(token, request);
  }
  const client = await clientFor(request);
  const { resourceUrl } = options;
  return (token) =>
    verifyClerkOAuthToken(client, token, audienceFor(resourceUrl, requestUrlOf(request)));
}

/**
 * The publishable key the metadata handlers read from the app's environment, or an error when it is not set or is
 * not a Clerk publishable key. The adapters read the variable themselves: Next.js only inlines
 * `process.env.NEXT_PUBLIC_*` where it is written out. The key is checked here, before any request to Clerk, so a
 * mistyped key throws to the framework as a missing one does, instead of being answered as Clerk's failure.
 * @param publishableKey - The value of the variable in the app's environment
 * @param name - The variable's name, for the error: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in Next.js
 * @returns The publishable key
 */
export function requirePublishableKey(
  publishableKey: string | undefined,
  name = 'CLERK_PUBLISHABLE_KEY',
): string {
  if (!publishableKey) {
    throw new Error(`${name} environment variable is required`);
  }
  try {
    // Deriving the authorization server is what decodes the key
    generateProtectedResourceMetadata({ resourceUrl: 'https://clerk.invalid', publishableKey });
  } catch (error) {
    throw new Error(
      `Clerk error: ${name} is not a Clerk publishable key. Copy it from the API keys page of the Clerk Dashboard`,
      { cause: error },
    );
  }
  return publishableKey;
}

/**
 * Throws a `Clerk error:` message when `authorizationServerMetadataHandler` received arguments. It takes none, so any
 * means it was passed to a route without being called, as 0.9.0's `authServerMetadataHandlerClerk` was, and the
 * framework called it with the request: that would otherwise hang the request in Express and Hono, and get a generic
 * error in Next.js.
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
 * Throws a `Clerk error:` message unless `Transport` is a class. Code written before `streamableHttpHandler` took the
 * SDK transport as an argument calls it with the server factory alone, which would otherwise fail on every request
 * instead of at startup.
 */
export function assertTransportClass(Transport: unknown, className: string, sdkModule: string) {
  if (typeof Transport !== 'function') {
    throw new Error(
      `Clerk error: streamableHttpHandler needs the MCP SDK transport class as its second argument. Import ${className} from '@modelcontextprotocol/sdk/server/${sdkModule}' and call streamableHttpHandler(createServer, ${className})`,
    );
  }
}

/**
 * Throws a `Clerk error:` message unless `createServer` is a function. Code written when the Express adapter also
 * accepted a shared server object passes that object here; a shared server handles only one request at a time, so this
 * fails at startup instead of on concurrent requests.
 */
export function assertServerFactory(createServer: unknown, transportClassName: string) {
  if (typeof createServer !== 'function') {
    throw new Error(
      `Clerk error: streamableHttpHandler needs a function that returns a new MCP server as its first argument, so each request gets its own server. Call streamableHttpHandler(() => new McpServer(...), ${transportClassName}) instead of passing a server object`,
    );
  }
}

/**
 * The JSON answer to a request whose token Clerk or `verifyToken` could not verify at all, such as during an outage or
 * with an invalid secret key. It is a server error, not a challenge, so the client keeps a token that may be valid. The
 * status is the `McpAuthError`'s 5xx `status` when it has one, otherwise 500.
 */
export function serverErrorAnswer(error: McpAuthError) {
  return { status: error.status ?? 500, body: { error: 'server_error' } } as const;
}

/**
 * The answer `authorizationServerMetadataHandler` gives when Clerk's authorization server metadata can't be fetched.
 * It is a 502 (RFC 9110 section 15.6.3): the handler relays the metadata of an upstream server, Clerk's Frontend API,
 * which failed. The error is logged with `console.error`, since the framework's error handler never sees it.
 * @param error - What `fetchAuthorizationServerMetadata` threw
 */
export function metadataUnavailableAnswer(error: unknown) {
  console.error(error);
  return { status: 502, body: { error: 'server_error' } } as const;
}

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

/**
 * The resource a protected resource metadata URL describes, the inverse of `resourceMetadataUrlFor`: the well-known
 * path is removed and the rest of the path and the query are kept as they are, so
 * `/.well-known/oauth-protected-resource/mcp/` describes `<origin>/mcp/` and the root describes the bare origin. RFC
 * 9728 section 3.3 has clients discard metadata whose `resource` is not identical to the URL they derived it from.
 */
export function resourceFromMetadataUrl(metadataUrl: string): string {
  const { origin, pathname, search } = new URL(metadataUrl);
  return `${origin}${pathname.replace('/.well-known/oauth-protected-resource', '')}${search}`;
}

/**
 * The response headers for a request `authenticateBearer` did not let through: the challenge, or for the 405 the
 * `Allow` header RFC 9110 section 15.5.6 requires. It lists only `POST` (RFC 9110 section 10.2.1): a stateless MCP
 * server has no sessions to stream on with GET or to end with DELETE, and MCP SDK 2's stateless serving answers both
 * with the same 405 and `Allow: POST`.
 * @param result - A result with `ok` false
 * @returns The headers to send with the status
 */
export function failureHeaders(
  result: Extract<BearerResult, { ok: false }>,
): Record<string, string> {
  if (result.status === 405) return { Allow: 'POST' };
  return result.challenge ? { 'WWW-Authenticate': result.challenge } : {};
}

/**
 * The JSON body for a request `authenticateBearer` did not let through. The 405 gets the same JSON-RPC error
 * `streamableHttpHandler` sends, so a GET gets one answer whether or not it carried a token.
 * @param result - A result with `ok` false
 * @returns The body to send with the status
 */
export function failureBody(result: Extract<BearerResult, { ok: false }>) {
  if (result.status === 405) return methodNotAllowed.body;
  return { error: result.error };
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

// The token from a well-formed `Bearer <token>` header. The scheme is case-insensitive. Malformed Bearer credentials
// are challenged like a missing header, not answered with the 400 `invalid_request` that RFC 6750 section 3.1
// suggests, so that a client sending an empty token can still start authorization.
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
 * Applies the response rule the adapters share. With a list of `resourceUrl`s, a request to an origin none of them has
 * gets a 421 without a challenge, before the token is read: no metadata URL there describes this server, and RFC 8707
 * section 3 audience-restricts a token so it cannot be presented to another resource. Otherwise the request uses the
 * listed URL with its origin. A missing or malformed header gets a challenge without an error code,
 * a rejected token adds `error="invalid_token"` (RFC 6750 section 3), and both 401 challenges list `requiredScopes`
 * then `challengeScopes` in `scope` (RFC 6750 section 3). A token without `requiredScopes` gets a 403 with
 * `error="insufficient_scope"` (RFC 6750 section 3.1). When a token lacks a `requiredScopes` entry, the 403 lists the
 * granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry, each once, as in
 * `requireAdditionalScopes`, so the new grant keeps the old access and covers the tools that step up to
 * `challengeScopes` too. A token that lacks only `challengeScopes` entries is let through. A verified token's auth info gets `resourceMetadataUrl`, which MCP SDK 2 puts in the
 * `resource_metadata` of its own scope challenges. A verifier that
 * throws an `McpTokenVerificationError` rejects the token, with that error as the failure's `cause`. Any other error
 * it throws gets wrapped in an `McpAuthError`.
 *
 * With `publicAccess`, a request without an `Authorization` header is not always challenged. A POST whose body
 * `isPublicRequest` accepts passes with `authInfo` `undefined`. A GET gets a 405 when the handshake is public: an MCP
 * client opens a GET stream once it has connected and starts authorization on a 401 there, which would make it sign in
 * before it reached anything protected, and the transport specification lets a server answer that GET with a 405 for
 * "no stream". From protocol revision 2026-07-28 the client opens a `subscriptions/listen` POST instead, which the
 * same handshake condition opens when every resource it subscribes to is open. Every other request without a token,
 * and every request with a header, is handled as above.
 */
export async function authenticateBearer({
  authorization,
  requestUrl,
  resourceUrl,
  requiredScopes = [],
  challengeScopes: extraChallengeScopes = [],
  publicAccess,
  method,
  body,
  verifyToken,
}: {
  authorization: string | undefined;
  /**
   * The URL the request was made to, used to pick a listed `resourceUrl`, or to derive one when it is not set.
   */
  requestUrl: string;
  resourceUrl: McpResourceUrl | undefined;
  requiredScopes: readonly string[] | undefined;
  challengeScopes: readonly string[] | undefined;
  publicAccess?: PublicAccess | undefined;
  /**
   * The request's HTTP method, which `publicAccess` needs: only a POST carries JSON-RPC messages.
   */
  method?: string | undefined;
  /**
   * Returns the request's parsed JSON body, or `undefined` when it cannot be read. It is called at most once, and
   * only for a POST without a token when `publicAccess` is set.
   */
  body?: (() => unknown) | undefined;
  verifyToken: (token: string) => AuthInfo | undefined | Promise<AuthInfo | undefined>;
}): Promise<BearerResult> {
  let resourceMetadataUrl: string;
  if (resourceUrl === undefined) {
    resourceMetadataUrl = requestResourceMetadataUrl(requestUrl);
  } else {
    const matched = matchResourceUrl(resourceUrl, requestUrl);
    if (!matched) {
      return {
        ok: false,
        failure: { reason: 'misdirected_request' },
        status: 421,
        challenge: undefined,
        error: 'misdirected_request',
      };
    }
    resourceMetadataUrl = resourceMetadataUrlFor(matched);
  }

  const unauthorizedScopes = requestedScopes({
    requiredScopes,
    challengeScopes: extraChallengeScopes,
  });

  const parsed = parseAuthorization(authorization);
  // Only a request without an `Authorization` header, or with an empty one, can be public. A malformed header is a
  // failed attempt to authenticate.
  if ('reason' in parsed && parsed.reason === 'missing_token' && publicAccess) {
    const httpMethod = method?.toUpperCase();
    if (httpMethod === 'POST' && isPublicRequest(publicAccess, await body?.())) {
      return { ok: true, authInfo: undefined };
    }
    if (httpMethod === 'GET' && opensHandshake(publicAccess)) {
      return {
        ok: false,
        failure: undefined,
        status: 405,
        challenge: undefined,
        error: 'method_not_allowed',
      };
    }
  }
  if ('reason' in parsed) {
    return {
      ok: false,
      failure: { reason: parsed.reason },
      status: 401,
      challenge: bearerChallenge({ resourceMetadataUrl, scopes: unauthorizedScopes }),
      error: 'Unauthorized',
    };
  }

  let authInfo: AuthInfo | undefined;
  let rejection: McpTokenVerificationError | undefined;
  try {
    authInfo = await verifyToken(parsed.token);
  } catch (error) {
    if (!(error instanceof McpTokenVerificationError)) {
      throw error instanceof McpAuthError ? error : new McpAuthError(error);
    }
    rejection = error;
  }

  // An expired token gets `invalid_token` (RFC 6750 section 3.1). Clerk rejects an expired token itself, but a
  // `verifyToken` passed to `mcpAuth` can return the auth info of a token it decoded or cached. An `expiresAt` that is
  // not a finite number, such as `NaN`, is not a time the token is valid until, so it is rejected too.
  if (
    authInfo?.expiresAt !== undefined &&
    !(Number.isFinite(authInfo.expiresAt) && authInfo.expiresAt > Date.now() / 1000)
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

  if (!authInfo) {
    return {
      ok: false,
      failure: { reason: 'invalid_token', ...(rejection && { cause: rejection }) },
      status: 401,
      challenge: bearerChallenge({
        resourceMetadataUrl,
        error: 'invalid_token',
        scopes: unauthorizedScopes,
      }),
      error: 'Unauthorized',
    };
  }

  // Only a missing `requiredScopes` entry gets the 403, and it also asks for the missing `challengeScopes`, so a
  // client that reauthorizes with its `scope` gets every tool's scopes at once
  const scopes = challengeScopes(requiredScopes, authInfo, unauthorizedScopes);
  if (scopes) {
    return {
      ok: false,
      failure: { reason: 'insufficient_scope' },
      status: 403,
      challenge: bearerChallenge({ resourceMetadataUrl, error: 'insufficient_scope', scopes }),
      error: 'insufficient_scope',
    };
  }

  // MCP SDK 2 reads `resourceMetadataUrl` from the auth info for the challenges its `scopeChallenge` tools send
  return { ok: true, authInfo: { ...authInfo, resourceMetadataUrl } };
}

// The reasons Clerk gives when it could not verify a token at all, such as during an outage or with an invalid secret
// key, as opposed to when it rejected the token. `jwk-remote-failed-to-load` is the reason `@clerk/backend` releases
// after 3.27.0 give a JWT access token whose JWKS can't be loaded; 3.27.0 does not declare it yet, so the element type
// is widened to take it.
const verificationUnavailable: ReadonlySet<string> = new Set<
  MachineTokenVerificationErrorCode | 'jwk-remote-failed-to-load'
>(['unexpected-error', 'secret-key-invalid', 'jwk-remote-failed-to-load']);

// Clerk keeps the Backend API's status only in the message, as `Unexpected error (code=unexpected-error, status=503)`.
// The pattern mirrors `MachineTokenVerificationError.getFullMessage()` in `@clerk/backend` 3.27.0,
// `dist/chunk-U3UVQERL.mjs:73`: `${this.message} (code=${this.code}, status=${this.status || "n/a"})`, which
// `handleMachineError` (`dist/chunk-CSXNUYCW.mjs:7801`) makes the request state's `message`.
function clerkStatus(message: string | undefined): number | undefined {
  const status = /\(code=[^,()]*, status=(\d{3})\)$/.exec(message ?? '')?.[1];
  return status === undefined ? undefined : Number(status);
}

// Whether Clerk could not verify the token at all, so the client must keep it. A Backend API 4xx other than 401
// (an invalid secret key) and 429 (rate limiting) is Clerk refusing the token. Releases of `@clerk/backend` after
// 3.27.0 report a JWKS that can't be loaded as `jwk-remote-failed-to-load`, which carries no Backend API status and
// is always unavailable. Through 3.27.0 a JWT access token whose JWKS can't be fetched gets the reason an invalid
// signature gets, so only the message tells the two apart. The prefix mirrors `fetchJWKSFromBAPI` in `@clerk/backend`
// 3.27.0, `dist/chunk-CSXNUYCW.mjs:1979`: `Error loading Clerk JWKS from ${url.href} with code=${response.status}`,
// whose `jwk-remote-failed-to-load` reason `resolveKeyAndVerifyJwt` (`:2111-2117`) replaces with
// `token-verification-failed`, keeping the message. Drop the prefix rule once the peer range starts after 3.27.0.
function isVerificationUnavailable(reason: string, message: string, status: number | undefined) {
  if (reason === 'token-verification-failed') return message.startsWith('Error loading Clerk JWKS');
  if (!verificationUnavailable.has(reason)) return false;
  return status === undefined || status < 400 || status >= 500 || status === 401 || status === 429;
}

/**
 * Verifies an OAuth access token with Clerk, requiring `audience` in its `aud` claim. For a token Clerk rejects, this
 * throws an `McpTokenVerificationError` with the reason and message Clerk gave, so that the token reaches the client
 * as an `invalid_token` challenge. When Clerk could not verify the token at all, this throws an `McpAuthError` around
 * that error instead and the framework answers with a server error: an `invalid_token` challenge would make the
 * client discard a valid token and restart authorization. For an opaque token that covers a Backend API check that
 * failed with a 429, a 5xx, or no response, which the answer keeps as its status (500 without one), and an invalid
 * secret key. A Backend API 4xx other than 401 and 429 is a rejection. For a JWT access token it covers a JWKS that
 * can't be loaded. With `@clerk/backend` releases after 3.27.0, which report it as `jwk-remote-failed-to-load`, that is
 * every such failure: an error status, a fetch that throws, an error body that is not JSON, a missing secret key, or a
 * JWKS without keys; an invalid secret key is `secret-key-invalid`, also covered. Through 3.27.0 it covers only a JWKS
 * request that Clerk answered with an error status and a JSON body, other than an invalid secret key: that release
 * reports every other failure to load the JWKS with the reason an invalid signature gets, so those still reach the
 * client as an `invalid_token` challenge.
 */
export async function verifyClerkOAuthToken(
  client: ClerkOAuthClient,
  token: string,
  audience: string,
) {
  // Clerk compares the audience exactly, and a client can send the resource in normalized form, such as
  // `https://mcp.example.com/` for `https://mcp.example.com`, so both forms of the same URL are accepted. For the root
  // the bare origin is accepted too, because that is the `resource` the protected resource metadata describes for it.
  const url = new URL(audience);
  const forms = [audience, url.href];
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
