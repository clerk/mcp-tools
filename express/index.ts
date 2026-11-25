import type { AuthInfo, McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type express from 'express';
import {
  type MetadataAnswer,
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  PUBLIC_BODY_LIMIT,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMcpAuthOptions,
  assertMiddlewareAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertStreamableHttpArgs,
  assertVerifierOrResourceUrl,
  authorizationServerMetadataAnswer,
  createBearerAuth,
  methodNotAllowed,
  protectedResourceMetadataAnswer,
  requireClerkEnvKeys,
  serverErrorAnswer,
  UnreadableBodyError,
} from '../bearer-auth';
import {
  type AuthFailureAnswer,
  type ReportingOption,
  AUTH_FAILURE_BODY_LIMIT,
  beginToolCallContext,
  checkToolCallContext,
  reportAuthFailure,
  reportingKey,
  resolveReporting,
  withoutReporting,
} from '../tool-call-reporting';
import {
  type AICatalogHandlerOptions,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type ServerCardHandlerOptions,
  aiCatalogResponder,
  serverCardResponder,
} from '../discovery-response';
import { type ClerkOAuthClient, type McpAuthFailure, metadataCorsHeaders } from '../server';

declare global {
  namespace Express {
    interface Locals {
      /**
       * Why `mcpAuth` answered this request with a 401 or 403 challenge or a 421, when it did.
       */
      mcpAuthFailure?: McpAuthFailure;
    }
  }
}

// Everything in the core subpath, so an Express app imports from this subpath alone
export * from '../server';

export type { AICatalogHandlerOptions, ServerCardHandlerOptions };

/**
 * Options for `clerkInstrumentHandler`. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as
 * its audience, and `clerkClient` defaults to `clerkClient` from `@clerk/express`. With `verifyToken`, that function
 * verifies each token with the Express request, `resourceUrl` is optional, and `clerkClient` is not allowed.
 * `reporting` turns on tool call reporting. The deprecated `mcpAuth` takes the same options without it.
 */
export type McpAuthOptions = MiddlewareAuthOptions<express.Request> &
  ReportingOption<express.Request>;

/**
 * What `clerkInstrumentHandler` serves: the handler `createMcpHandler` from MCP SDK 2.x (`@modelcontextprotocol/server`)
 * returns, served through `toNodeHandler` from `@modelcontextprotocol/node`, or an Express handler of your own, such as
 * one that serves MCP SDK 1.x's `StreamableHTTPServerTransport`.
 */
export type McpHandler =
  | {
      fetch: (
        request: Request,
        options?: { authInfo?: AuthInfo; parsedBody?: unknown },
      ) => Promise<Response>;
    }
  | ((req: express.Request, res: express.Response, next: express.NextFunction) => unknown);

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions`, all optional, plus `properties`. Reuse the
 * auth options here, adding `properties` only for the metadata handler, not `mcpAuth`. The handler reads
 * `resourceUrl`, `requiredScopes`, `challengeScopes`, and `properties`, and
 * ignores the other `McpAuthOptions` keys: `clerkClient`, `verifyToken`, and `reporting`.
 */
export type ProtectedResourceMetadataOptions =
  SharedProtectedResourceMetadataOptions<McpAuthOptions>;

/**
 * The part of a Node.js streamable HTTP server transport, such as `StreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/streamableHttp.js`, that `streamableHttpHandler` uses.
 */
interface NodeStreamableHttpTransport {
  /**
   * Handles one MCP request, carrying the auth info `mcpAuth` set in `req.auth`, and writes the response.
   */
  handleRequest(req: express.Request, res: express.Response, parsedBody: unknown): Promise<void>;
  /**
   * Closes the transport.
   */
  close(): Promise<void>;
}

/**
 * Express middleware that enforces authentication for MCP requests. By default it verifies the OAuth access token with
 * Clerk, including that its audience is this endpoint; pass `verifyToken` to verify tokens with your own function.
 * @param options - See `McpAuthOptions`. `clerkClient` defaults to `clerkClient` from `@clerk/express`, which reads
 * `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`; pass your own when the keys come from elsewhere. The route doesn't
 * need `clerkMiddleware()`: this middleware verifies the token itself.
 * @returns The middleware. A missing or rejected token gets a 401 challenge, a token without `requiredScopes` gets a
 * 403 challenge, and a request to an origin no `resourceUrl` lists gets a 421. The reason is recorded on
 * `res.locals.mcpAuthFailure`. A token that could not be verified at all gets a JSON server error, and the
 * `McpAuthError` is logged with `console.error`. Without a `clerkClient` option, every request throws a
 * `Clerk error:` naming a missing key, or asking to install `@clerk/express` when it can't be loaded.
 * @example
 * ```ts
 * // Every method, so a GET without a token gets the 401 (or the 405 with publicAccess) rather than a 404
 * app.all(
 *   "/mcp",
 *   express.json(),
 *   mcpAuth({
 *     resourceUrl: "https://mcp.example.com/mcp",
 *     requiredScopes: ["profile", "email"],
 *   }),
 *   streamableHttpHandler(createServer, StreamableHTTPServerTransport),
 * );
 * ```
 * @example
 * ```ts
 * async function verifyToken(token, req) {
 *   const authData = // verify the token and return the auth data
 *   return authData;
 * }
 *
 * app.all(
 *   "/mcp",
 *   express.json(),
 *   mcpAuth({ verifyToken, resourceUrl: "https://mcp.example.com/mcp" }),
 *   streamableHttpHandler(createServer, StreamableHTTPServerTransport),
 * );
 * ```
 * @deprecated Use `clerkInstrumentHandler(handler, options)`, which authenticates the same way and can report tool calls
 */
export function mcpAuth(options: MiddlewareAuthOptions<express.Request>) {
  options = withoutReporting('mcpAuth', options);
  assertMiddlewareAuthOptions(options);
  const authenticate = expressAuthenticator('mcpAuth', options);

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (await authenticate(req, res)) next();
  };
}

/**
 * Verifies the request's token as `mcpAuth` does, answering the request itself when it is not let through.
 * @param onFailure - Called with a 401, 403 or 421 as it is answered, for reporting. It must not wait for anything.
 * @returns Whether the request was let through, with `req.auth` set to its auth info, or `undefined` for a request
 * without a token that `publicAccess` let through
 */
function expressAuthenticator(
  caller: string,
  options: MiddlewareAuthOptions<express.Request>,
  onFailure?: (req: express.Request, answer: AuthFailureAnswer) => void,
) {
  const authenticate = createBearerAuth(
    caller,
    options,
    expressClerkClient(caller),
    "clerkClient from '@clerk/express'",
  );

  return async (
    req: express.Request,
    res: express.Response,
  ): Promise<{ authInfo: AuthInfo | undefined } | undefined> => {
    const result = await authenticate(req, {
      // Join every `Authorization` value as fetch `Headers` do for the other adapters. Non-empty duplicates are
      // challenged as malformed; an empty duplicate can leave a comma in the token for the verifier to reject.
      // `req.headers.authorization` keeps only the first value, and would verify that one.
      authorization: req.headersDistinct.authorization?.join(', '),
      requestUrl: getRequestUrl(req),
      method: req.method,
      body: () => parsedJsonBody(req, caller),
    });
    if ('serverError' in result) {
      // Logged here, not passed to `next`: Express's default error handler destroys the socket of a sent response,
      // which resets a client still uploading its body, and `finish` never fires when the client disconnects
      const answer = serverErrorAnswer(result.serverError);
      res.status(answer.status).json(answer.body);
      return undefined;
    }
    if (!result.ok) {
      if (result.failure) {
        res.locals.mcpAuthFailure = result.failure;
        // Reporting must never change, fail or delay the answer
        try {
          onFailure?.(req, {
            failure: result.failure,
            status: result.status,
            authInfo: result.authInfo,
          });
        } catch {}
      }
      res.status(result.status).set(result.headers).json(result.body);
      return undefined;
    }

    // For a request `publicAccess` let through this is `undefined`, which also clears an `auth` that another
    // middleware set, so the MCP transport never takes one for the auth info of a token.
    (req as express.Request & { auth?: AuthInfo }).auth = result.authInfo;
    return { authInfo: result.authInfo };
  };
}

/**
 * `clerkClient` from `@clerk/express`. The package is an optional peer that only this path needs, so it is loaded with
 * `import()` inside `try`, and an app that passes `verifyToken` or its own `clerkClient` does not need it installed.
 * @param caller - The entry point named in its errors
 * @returns A function returning the client. It throws a `Clerk error:` asking to install `@clerk/express` when the
 * package can't be loaded, with the load error as the `cause`, or naming `CLERK_SECRET_KEY` or `CLERK_PUBLISHABLE_KEY`
 * when it is not set.
 */
function expressClerkClient(caller: string) {
  return async (): Promise<ClerkOAuthClient> => {
    let clerkExpress: typeof import('@clerk/express');
    try {
      clerkExpress = await import('@clerk/express');
    } catch (error) {
      throw new Error(`Clerk error: install @clerk/express, or pass clerkClient to ${caller}`, {
        cause: error,
      });
    }
    // `@clerk/express` reads both keys from the environment only when a token is verified, and a missing one would
    // then look like a Clerk outage, so they are checked here as Hono's adapter checks its own
    requireClerkEnvKeys(caller, {
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
    });
    return clerkExpress.clerkClient;
  };
}

/**
 * The JSON body `express.json()` parsed, which `discoverable` and `publicAccess` check. Without that middleware a
 * JSON request has no parsed body, so it throws an `UnreadableBodyError`: the request gets the 401 challenge, and a
 * one-time warning names the fix. With `discoverable: false` and nothing else open, the body is never read.
 * `express.json()`'s `limit` bounds decoded bytes, not encoded bytes. A content-encoded body cannot be public because
 * the parsed body cannot establish its original size. Without a `Content-Length`, an identity body's size check uses
 * the parsed body serialized again, not the byte count sent (see `PUBLIC_BODY_LIMIT`).
 * @param req - The incoming request
 * @returns The parsed body, or `undefined` when the request has no JSON body or is over `PUBLIC_BODY_LIMIT`
 */
function parsedJsonBody(req: express.Request, caller: string): unknown {
  if (!req.is('application/json')) return undefined;
  // The upstream parser may inflate a small JSON body from arbitrarily many encoded bytes (for example, a gzip
  // comment). Its decoded-byte limit cannot establish the size of that request for anonymous admission.
  if ((req.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity') return undefined;
  if (req.body === undefined) {
    throw new UnreadableBodyError(
      `Clerk warning: ${caller} could not read the JSON body of a request without a token, so discoverable and publicAccess open nothing and the request got the 401 challenge. Mount express.json() before ${caller}, as app.use(express.json()), or set discoverable: false to require a token for every request`,
    );
  }
  const declared = req.get('content-length');
  const size =
    declared === undefined ? Buffer.byteLength(JSON.stringify(req.body)) : Number(declared);
  return size > PUBLIC_BODY_LIMIT ? undefined : req.body;
}

/**
 * The JSON body `express.json()` parsed for a request that failed authentication, for its JSON-RPC method and tool
 * name. The stream is never read here, and a body over `AUTH_FAILURE_BODY_LIMIT` bytes is left out.
 */
function failedRequestBody(req: express.Request): unknown {
  if (!req.is('application/json') || req.body === undefined) return undefined;
  const declared = req.get('content-length');
  const size =
    declared === undefined ? Buffer.byteLength(JSON.stringify(req.body)) : Number(declared);
  return size > AUTH_FAILURE_BODY_LIMIT ? undefined : req.body;
}

/**
 * An Express handler that serves the RFC 8414 authorization server metadata of the Clerk instance named by
 * `CLERK_PUBLISHABLE_KEY`, fetched from its Frontend API on each request.
 * @see https://datatracker.ietf.org/doc/html/rfc8414#section-3
 * @returns The handler. It throws when `CLERK_PUBLISHABLE_KEY` is not set. Passing
 * `authorizationServerMetadataHandler` to the route without calling it throws a `Clerk error:` on the first request.
 * @example
 * ```ts
 * app.all(
 *   "/.well-known/oauth-authorization-server",
 *   authorizationServerMetadataHandler()
 * );
 * ```
 */
export function authorizationServerMetadataHandler() {
  assertAuthorizationServerMetadataHandlerCalled(arguments.length);
  return async (req: express.Request, res: express.Response): Promise<void> => {
    if (req.method === 'OPTIONS') return void res.status(200).set(metadataCorsHeaders).end();
    sendMetadata(
      res,
      await authorizationServerMetadataAnswer({
        publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
      }),
    );
  };
}

/**
 * An Express handler that serves RFC 9728 protected resource metadata for the Clerk instance named by
 * `CLERK_PUBLISHABLE_KEY`. Mount it at the path `mcpAuth`'s challenge points to.
 * @see https://datatracker.ietf.org/doc/html/rfc9728#section-3
 * @param options - See `ProtectedResourceMetadataOptions`
 * @returns The handler. A request to an origin no listed `resourceUrl` has gets a 421. It throws when
 * `CLERK_PUBLISHABLE_KEY` is not set.
 * @example
 * ```ts
 * app.all(
 *   "/.well-known/oauth-protected-resource/mcp",
 *   protectedResourceMetadataHandler({ resourceUrl: "https://mcp.example.com/mcp" })
 * );
 * ```
 */
export function protectedResourceMetadataHandler(options: ProtectedResourceMetadataOptions = {}) {
  assertProtectedResourceMetadataOptions(options, new Set([reportingKey]));

  return (req: express.Request, res: express.Response): void => {
    if (req.method === 'OPTIONS') return void res.status(200).set(metadataCorsHeaders).end();
    varyOnForwardedOrigin(req, res, typeof options.resourceUrl !== 'string');
    sendMetadata(
      res,
      protectedResourceMetadataAnswer(options, {
        publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
        url: getRequestUrl(req),
      }),
    );
  };
}

/**
 * An Express handler that serves an MCP Server Card, the public document a client reads before it connects to learn
 * what the server is and where to connect. It validates the options and generates the card when it is created, so it
 * needs no Clerk keys or MCP SDK and makes no request, and later changes to the options change nothing. Mount it with
 * `app.all` so OPTIONS and other methods reach it; importing it mounts nothing.
 *
 * Any origin can read the card. GET and HEAD get it with a weak `ETag` and `Cache-Control: public, max-age=3600`, or
 * `maxAge`'s seconds (`public, no-cache` for `0`), and a matching `If-None-Match` gets a 304 without a body. OPTIONS
 * gets the CORS preflight, another method a 405, and a request to an origin no listed `resourceUrl` has a 421, each
 * error with `Cache-Control: no-store`. An absolute-form request target supplies its own origin. For origin-form,
 * the origin is `req.protocol` and `req.host`, which come from `X-Forwarded-*` headers only when the app sets
 * `trust proxy`. With a list of `resourceUrl`s, a request without a valid absolute-form target or a `Host` header
 * that parses gets a 400; a single `resourceUrl` never reads the request's URL.
 * @see https://github.com/modelcontextprotocol/ext-server-card
 * @param options - See `ServerCardHandlerOptions`
 * @returns The handler. It throws a `Clerk error:` naming the first option the card cannot have.
 * @example
 * ```ts
 * app.all(
 *   "/mcp/server-card",
 *   serverCardHandler({
 *     name: "com.example/weather",
 *     version: "1.2.0",
 *     description: "Forecasts and current conditions.",
 *     resourceUrl: "https://mcp.example.com/mcp",
 *   }),
 * );
 * ```
 */
export function serverCardHandler(options: ServerCardHandlerOptions) {
  return discoveryHandler(
    serverCardResponder('serverCardHandler', options),
    Array.isArray((options as { resourceUrl?: unknown } | null)?.resourceUrl),
  );
}

/**
 * An Express handler that serves an AI Catalog linking to MCP Server Cards, the document a client reads at
 * `/.well-known/ard.json`, or its predecessor path `/.well-known/ai-catalog.json`, to find a domain's MCP servers. It
 * validates the options and generates the catalog when it is created, so it needs no Clerk keys or MCP SDK and never
 * fetches the cards it links to, and later changes to the options change nothing. The catalog is the same for every
 * request: to answer on several origins with their own cards, create one handler for each and pick it by origin. Mount
 * it at both paths with `app.all` so OPTIONS and other methods reach it; importing it mounts nothing.
 *
 * Any origin can read the catalog, served as `application/ai-catalog+json`. GET and HEAD get it with a weak `ETag` and
 * `Cache-Control: public, max-age=3600`, or `maxAge`'s seconds (`public, no-cache` for `0`), and a matching
 * `If-None-Match` gets a 304 without a body. OPTIONS gets the CORS preflight and another method a 405 with
 * `Cache-Control: no-store`. The request's URL is never read, so a request without a `Host` header still gets the
 * catalog, and both paths get the same body and headers.
 * @see https://github.com/Agent-Card/ai-catalog
 * @see https://agenticresourcediscovery.org/spec/#51-discovery-mechanisms
 * @param options - See `AICatalogHandlerOptions`
 * @returns The handler. It throws a `Clerk error:` naming the first option the catalog cannot have.
 * @example
 * ```ts
 * app.all(
 *   ["/.well-known/ard.json", "/.well-known/ai-catalog.json"],
 *   aiCatalogHandler({
 *     entries: [
 *       {
 *         identifier: "urn:air:example.com:weather",
 *         displayName: "Weather",
 *         url: "https://mcp.example.com/mcp/server-card",
 *       },
 *     ],
 *   }),
 * );
 * ```
 */
export function aiCatalogHandler(options: AICatalogHandlerOptions) {
  return discoveryHandler(aiCatalogResponder('aiCatalogHandler', options));
}

function discoveryHandler(
  respond: (request: DiscoveryRequest) => DiscoveryAnswer,
  dependsOnRequestOrigin = false,
) {
  return (req: express.Request, res: express.Response): void => {
    const { status, headers, body } = respond({
      method: req.method,
      url: getRequestUrl(req),
      // Node joins repeated If-Match and If-None-Match headers with commas
      ifMatch: req.get('if-match'),
      ifNoneMatch: req.get('if-none-match'),
    });
    // `setHeader`, not `set`, which would add `; charset=utf-8` to `application/json`, and `end`, not `send` or `json`,
    // which add an ETag of their own and answer a 304 by Express's own freshness rules
    varyOnForwardedOrigin(req, res, dependsOnRequestOrigin);
    const exposeHeaders = res.getHeader('access-control-expose-headers');
    const mergedExposeHeaders =
      typeof exposeHeaders === 'string' || Array.isArray(exposeHeaders)
        ? [...(Array.isArray(exposeHeaders) ? exposeHeaders : [exposeHeaders])]
            .flatMap((value) => value.split(','))
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined;
    if (
      mergedExposeHeaders &&
      !mergedExposeHeaders.includes('*') &&
      !mergedExposeHeaders.some((header) => header.toLowerCase() === 'etag')
    ) {
      mergedExposeHeaders.push('ETag');
    }
    res.status(status);
    // An answer without a validator, such as an error, keeps none an earlier middleware set. No earlier length survives
    // either: a body is sent with its own, a HEAD answer carries the GET's, and another bodyless answer has none.
    // `removeHeader` only when one was set, since it also stops Node framing a body by its length.
    if (headers.ETag === undefined) res.removeHeader('etag');
    if (body !== null) res.setHeader('content-length', Buffer.byteLength(body));
    else if (headers['Content-Length'] === undefined && res.hasHeader('content-length')) {
      res.removeHeader('content-length');
    }
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (mergedExposeHeaders) {
      res.setHeader('access-control-expose-headers', mergedExposeHeaders.join(', '));
    }
    res.end(body ?? undefined);
  };
}

function varyOnForwardedOrigin(
  req: express.Request,
  res: express.Response,
  dependsOnRequestOrigin: boolean,
): void {
  if (
    !dependsOnRequestOrigin ||
    !req.originalUrl.startsWith('/') ||
    !req.app.get('trust proxy fn')(req.socket.remoteAddress, 0)
  ) {
    return;
  }
  // Include absent headers too: either can select another origin (RFC 9110 section 12.5.5).
  res.vary('X-Forwarded-Host');
  res.vary('X-Forwarded-Proto');
}

function sendMetadata(res: express.Response, { status, headers, body }: MetadataAnswer) {
  res.status(status).set(headers).json(body);
}

// Absolute-form targets supply the whole URL, including authority and scheme (RFC 9112 sections 3.2.2 and 3.3).
// For origin-form, preserve Express's proxy policy: `req.protocol` and `req.host` read `X-Forwarded-*` only when the
// app sets `trust proxy`. A malformed or unsupported target returns `undefined`, never a URL repaired by `URL`.
function getRequestUrl(req: express.Request): string | undefined {
  const target = req.originalUrl;
  if (!target.startsWith('/')) {
    if (
      !/^https?:\/\/[^/?#\\@]+(?:[/?]|$)/i.test(target) ||
      target.includes('\\') ||
      target.includes('#') ||
      !URL.canParse(target)
    ) {
      return undefined;
    }
    return new URL(target).href;
  }

  const host = req.host as string | undefined;
  if (!host) return undefined;
  const url = `${req.protocol}://${host}${target}`;
  return URL.canParse(url) ? url : undefined;
}

/**
 * An express handler that will handle MCP requests using the streamable http transport, given a factory that creates an
 * MCP server object from the MCP SDK. A fresh server and transport are created for each request so that concurrent
 * requests don't share state.
 * @param createServer - A factory that returns a new MCP server, such as `McpServer` from the MCP SDK, on every call.
 * Passing a server object instead throws when the handler is created.
 * @param Transport - The SDK's Node.js transport class, `StreamableHTTPServerTransport` from
 * `@modelcontextprotocol/sdk/server/streamableHttp.js`. It is taken as an argument so that this package never imports
 * the SDK, which only apps serving MCP with this handler need to install.
 * @returns The handler
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
 *
 * function createServer() {
 *   const server = new McpServer({
 *     name: "test-server",
 *     version: "0.0.1",
 *   });
 *
 *   // define server tools, resources, etc...
 *
 *   return server;
 * }
 *
 * // A request that isn't a POST gets a 405 with `Allow: POST`: the server is stateless
 * app.all("/mcp", express.json(), streamableHttpHandler(createServer, StreamableHTTPServerTransport));
 * ```
 * @typeParam Transport - The transport the class creates, inferred from the class alone
 * @typeParam Server - The server `createServer` returns. It is a separate type parameter so that `Transport` is not
 * inferred from the SDK's general `Transport` interface, which `McpServer.connect` takes.
 * @deprecated Use `clerkInstrumentHandler(handler, options)` with the handler `createMcpHandler` from MCP SDK 2.x returns
 */
export function streamableHttpHandler<
  Transport extends NodeStreamableHttpTransport,
  Server extends McpServerLike<Transport>,
>(createServer: () => Server, Transport: StreamableHttpTransportClass<Transport>) {
  assertStreamableHttpArgs(
    createServer,
    Transport,
    'StreamableHTTPServerTransport',
    'streamableHttp.js',
  );

  return async (req: express.Request, res: express.Response) => {
    if (req.method !== 'POST') {
      res.status(methodNotAllowed.status).set(methodNotAllowed.headers).json(methodNotAllowed.body);
      return;
    }

    const server = createServer();
    const transport = new Transport({ sessionIdGenerator: undefined });

    // close() rejects if a consumer onclose hook throws; an unhandled rejection would kill the process
    const closeTransport = () => transport.close().catch(() => undefined);

    // closing detaches the transport; otherwise the next connect() throws and kills the endpoint
    res.on('close', closeTransport);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await closeTransport();
      throw error;
    }
  };
}

type NodeMcpHandler = (
  req: express.Request,
  res: express.Response,
  parsedBody?: unknown,
) => Promise<void>;

/**
 * An Express handler that authenticates each MCP request as `mcpAuth` does, then serves it with `handler`. It answers a
 * missing or rejected token with a 401 challenge, a token without `requiredScopes` with a 403 challenge, and a request
 * to an origin no `resourceUrl` lists with a 421, recording the reason on `res.locals.mcpAuthFailure`. A request it
 * lets through reaches `handler` with its auth info on `req.auth`, where MCP SDK transports read it.
 *
 * With `reporting`, it reports to Clerk the tool calls of each server passed to `clerkInstrumentServer`, and each 401,
 * 403 or 421 it answers. Reports are sent in batches, about a second after a call or once 100 are waiting, with the
 * `CLERK_SECRET_KEY` the app's environment has.
 * @param handler - The handler `createMcpHandler` from `@modelcontextprotocol/server` returns, which needs
 * `@modelcontextprotocol/node` installed, or an Express handler of your own
 * @param options - See `McpAuthOptions`. `clerkClient` defaults to `clerkClient` from `@clerk/express`, which reads
 * `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`.
 * @returns The Express handler. Mount it with `app.all` after `express.json()`, which `publicAccess` reads the body
 * from.
 * @example
 * ```ts
 * import express from 'express';
 * import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
 * import { clerkInstrumentHandler, clerkInstrumentServer } from '@clerk/mcp-tools/express';
 *
 * const mcp = createMcpHandler(() => {
 *   const server = new McpServer({ name: 'acme-mcp', version: '1.0.0' });
 *   clerkInstrumentServer(server);
 *   // register tools
 *   return server;
 * });
 *
 * const app = express();
 * app.use(express.json());
 * app.all(
 *   '/mcp',
 *   clerkInstrumentHandler(mcp, {
 *     resourceUrl: 'https://mcp.example.com/mcp',
 *     requiredScopes: ['profile', 'email'],
 *     reporting: true,
 *   }),
 * );
 * ```
 */
export function clerkInstrumentHandler(handler: McpHandler, options: McpAuthOptions) {
  if (
    typeof handler !== 'function' &&
    typeof (handler as { fetch?: unknown } | null)?.fetch !== 'function'
  ) {
    throw new Error(
      'Clerk error: clerkInstrumentHandler takes the MCP handler first: the handler createMcpHandler from @modelcontextprotocol/server returns, or an Express handler. Call it as clerkInstrumentHandler(handler, { resourceUrl })',
    );
  }
  assertVerifierOrResourceUrl(
    options,
    `Clerk error: clerkInstrumentHandler needs a resourceUrl to verify tokens with Clerk. Call it as clerkInstrumentHandler(handler, { resourceUrl: 'https://mcp.example.com/mcp' }), or as clerkInstrumentHandler(handler, { verifyToken }) with your own verifier`,
  );
  const { reporting: reportingOption, ...authOptions } = options;
  assertMcpAuthOptions('clerkInstrumentHandler', authOptions);
  const reporting = resolveReporting<express.Request>('clerkInstrumentHandler', reportingOption);
  const authenticate = expressAuthenticator(
    'clerkInstrumentHandler',
    authOptions,
    reporting &&
      ((req, answer) => {
        // Sent on the reporter's timer, or before Node.js exits. The body is the one `express.json()` already parsed,
        // so nothing is read and the answer doesn't wait.
        void reportAuthFailure({
          caller: 'clerkInstrumentHandler',
          reporting,
          answer,
          body: failedRequestBody(req),
          request: req,
          defaultIpAddress: () => req.ip,
          userAgent: () => req.get('user-agent'),
          env: { secretKey: process.env.CLERK_SECRET_KEY, apiUrl: process.env.CLERK_API_URL },
        });
      }),
  );
  let nodeHandler: Promise<NodeMcpHandler> | undefined;

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const authenticated = await authenticate(req, res);
      if (!authenticated) return;

      const context = beginToolCallContext({
        caller: 'clerkInstrumentHandler',
        reporting,
        authInfo: authenticated.authInfo,
        request: req,
        defaultIpAddress: () => req.ip,
        userAgent: () => req.get('user-agent'),
        env: { secretKey: process.env.CLERK_SECRET_KEY, apiUrl: process.env.CLERK_API_URL },
      });
      if (context && reporting) {
        res.once('finish', () =>
          checkToolCallContext('clerkInstrumentHandler', context, reporting, {
            method: req.method,
            status: res.statusCode,
            mcpMethod: req.get('mcp-method'),
          }),
        );
      }

      if (typeof handler === 'function') {
        await handler(req, res, next);
        return;
      }
      nodeHandler ??= toNodeHandler(handler);
      // `express.json()` has already read the stream, so the body comes from what it parsed
      await (
        await nodeHandler
      )(req, res, req.body);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * `toNodeHandler` from `@modelcontextprotocol/node` around an MCP SDK 2.x handler. The package is an optional peer that
 * only this path needs, so it is loaded with `import()` inside `try`.
 */
async function toNodeHandler(handler: Exclude<McpHandler, Function>): Promise<NodeMcpHandler> {
  let node: typeof import('@modelcontextprotocol/node');
  try {
    node = await import('@modelcontextprotocol/node');
  } catch (error) {
    throw new Error(
      'Clerk error: install @modelcontextprotocol/node to serve an MCP SDK 2.x handler with clerkInstrumentHandler from @clerk/mcp-tools/express',
      { cause: error },
    );
  }
  return node.toNodeHandler(handler as Parameters<typeof node.toNodeHandler>[0]) as NodeMcpHandler;
}
