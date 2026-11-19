import type { McpServerLike, StreamableHttpTransportClass } from '../mcp-types';
import type express from 'express';
import {
  type MetadataAnswer,
  type MiddlewareAuthOptions,
  type ProtectedResourceMetadataOptions as SharedProtectedResourceMetadataOptions,
  PUBLIC_BODY_LIMIT,
  assertAuthorizationServerMetadataHandlerCalled,
  assertMiddlewareAuthOptions,
  assertProtectedResourceMetadataOptions,
  assertStreamableHttpArgs,
  authorizationServerMetadataAnswer,
  createBearerAuth,
  methodNotAllowed,
  protectedResourceMetadataAnswer,
  requireClerkEnvKeys,
  serverErrorAnswer,
} from '../bearer-auth';
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
 * Options for the `mcpAuth` middleware. Without `verifyToken`, Clerk verifies each token, `resourceUrl` is required as
 * its audience, and `clerkClient` defaults to `clerkClient` from `@clerk/express`. With `verifyToken`, that function
 * verifies each token with the Express request, `resourceUrl` is optional, and `clerkClient` is not allowed.
 */
export type McpAuthOptions = MiddlewareAuthOptions<express.Request>;

/**
 * Options for `protectedResourceMetadataHandler`: the `McpAuthOptions`, all optional, plus `properties`. Reuse the
 * auth options here, adding `properties` only for the metadata handler, not `mcpAuth`. The handler reads
 * `resourceUrl`, `requiredScopes`, `challengeScopes`, and `properties`, and
 * ignores the other `McpAuthOptions` keys: `clerkClient` and `verifyToken`.
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
 */
export function mcpAuth(options: McpAuthOptions) {
  assertMiddlewareAuthOptions(options);
  const authenticate = createBearerAuth(
    'mcpAuth',
    options,
    expressClerkClient,
    "clerkClient from '@clerk/express'",
  );

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const result = await authenticate(req, {
      // Every `Authorization` value, joined as fetch `Headers` join them for the other adapters, so two headers are
      // challenged as malformed. `req.headers.authorization` keeps only the first, and would verify that one.
      authorization: req.headersDistinct.authorization?.join(', '),
      requestUrl: getRequestUrl(req),
      method: req.method,
      body: () => parsedJsonBody(req),
    });
    if ('serverError' in result) {
      // Logged here, not passed to `next`: Express's default error handler destroys the socket of a sent response,
      // which resets a client still uploading its body, and `finish` never fires when the client disconnects
      const answer = serverErrorAnswer(result.serverError);
      res.status(answer.status).json(answer.body);
      return;
    }
    if (!result.ok) {
      if (result.failure) res.locals.mcpAuthFailure = result.failure;
      res.status(result.status).set(result.headers).json(result.body);
      return;
    }

    // For a request `publicAccess` let through this is `undefined`, which also clears an `auth` that another
    // middleware set, so the MCP transport never takes one for the auth info of a token.
    // @ts-expect-error - we're monkey patching this on purpose
    req.auth = result.authInfo;

    next();
  };
}

/**
 * `clerkClient` from `@clerk/express`. The package is an optional peer that only this path needs, so it is loaded with
 * `import()` inside `try`, and an app that passes `verifyToken` or its own `clerkClient` does not need it installed.
 * @returns The client. It throws a `Clerk error:` asking to install `@clerk/express` when the package can't be loaded,
 * with the load error as the `cause`, or naming `CLERK_SECRET_KEY` or `CLERK_PUBLISHABLE_KEY` when it is not set.
 */
async function expressClerkClient(): Promise<ClerkOAuthClient> {
  let clerkExpress: typeof import('@clerk/express');
  try {
    clerkExpress = await import('@clerk/express');
  } catch (error) {
    throw new Error('Clerk error: install @clerk/express, or pass clerkClient to mcpAuth', {
      cause: error,
    });
  }
  // `@clerk/express` reads both keys from the environment only when a token is verified, and a missing one would then
  // look like a Clerk outage, so they are checked here as Hono's adapter checks its own
  requireClerkEnvKeys('mcpAuth', {
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
  });
  return clerkExpress.clerkClient;
}

/**
 * The JSON body `express.json()` parsed, which `publicAccess` checks. Without that middleware a JSON request has no
 * parsed body, and every request without a token would get a 401 with nothing to say why, so that case throws.
 * `express.json()`'s `limit` bounds decoded bytes, not encoded bytes. A content-encoded body cannot be public because
 * the parsed body cannot establish its original size. Without a `Content-Length`, an identity body's size check uses
 * the parsed body serialized again, not the byte count sent (see `PUBLIC_BODY_LIMIT`).
 * @param req - The incoming request
 * @returns The parsed body, or `undefined` when the request has no JSON body or is over `PUBLIC_BODY_LIMIT`
 */
function parsedJsonBody(req: express.Request): unknown {
  if (!req.is('application/json')) return undefined;
  // The upstream parser may inflate a small JSON body from arbitrarily many encoded bytes (for example, a gzip
  // comment). Its decoded-byte limit cannot establish the size of that request for anonymous admission.
  if ((req.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity') return undefined;
  if (req.body === undefined) {
    throw new Error(
      'Clerk error: mcpAuth publicAccess reads the parsed JSON body of the request. Mount express.json() before mcpAuth, as app.use(express.json())',
    );
  }
  const declared = req.get('content-length');
  const size =
    declared === undefined ? Buffer.byteLength(JSON.stringify(req.body)) : Number(declared);
  return size > PUBLIC_BODY_LIMIT ? undefined : req.body;
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
  assertProtectedResourceMetadataOptions(options);

  return (req: express.Request, res: express.Response): void => {
    if (req.method === 'OPTIONS') return void res.status(200).set(metadataCorsHeaders).end();
    if (Array.isArray(options.resourceUrl)) varyOnForwardedOrigin(res);
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
 * `/.well-known/ai-catalog.json` to find a domain's MCP servers. It validates the options and generates the catalog
 * when it is created, so it needs no Clerk keys or MCP SDK and never fetches the cards it links to, and later changes
 * to the options change nothing. The catalog is the same for every request: to answer on several origins with their
 * own cards, create one handler for each and pick it by origin. Mount it with `app.all` so OPTIONS and other methods
 * reach it; importing it mounts nothing.
 *
 * Any origin can read the catalog, served as `application/ai-catalog+json`. GET and HEAD get it with a weak `ETag` and
 * `Cache-Control: public, max-age=3600`, or `maxAge`'s seconds (`public, no-cache` for `0`), and a matching
 * `If-None-Match` gets a 304 without a body. OPTIONS gets the CORS preflight and another method a 405 with
 * `Cache-Control: no-store`. The request's URL is never read, so a request without a `Host` header still gets the
 * catalog.
 * @see https://github.com/Agent-Card/ai-catalog
 * @param options - See `AICatalogHandlerOptions`
 * @returns The handler. It throws a `Clerk error:` naming the first option the catalog cannot have.
 * @example
 * ```ts
 * app.all(
 *   "/.well-known/ai-catalog.json",
 *   aiCatalogHandler({
 *     entries: [
 *       { identifier: "urn:air:example.com:mcp:weather", url: "https://mcp.example.com/mcp/server-card" },
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
  varyForForwardedOrigin = false,
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
    if (varyForForwardedOrigin) varyOnForwardedOrigin(res);
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
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (mergedExposeHeaders) {
      res.setHeader('access-control-expose-headers', mergedExposeHeaders.join(', '));
    }
    res.end(body ?? undefined);
  };
}

function varyOnForwardedOrigin(res: express.Response): void {
  const vary = res.getHeader('vary');
  const values = Array.isArray(vary) ? vary : typeof vary === 'string' ? vary.split(',') : [];
  if (values.some((value) => typeof value === 'string' && value.trim() === '*')) return;
  const fields = values.filter((value): value is string => typeof value === 'string');
  for (const name of ['X-Forwarded-Host', 'X-Forwarded-Proto']) {
    if (!fields.some((field) => field.trim().toLowerCase() === name.toLowerCase())) fields.push(name);
  }
  res.setHeader('Vary', fields.join(', '));
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
