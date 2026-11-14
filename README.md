# MCP Tools

A library built on top of the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) that makes it easier to implement MCP with auth into your MCP client and/or server.

### What is MCP?

It's a protocol that enables AI applications like Claude, ChatGPT, Cursor, etc to ask you for permission to access some of your private information that normally you'd need to sign in with your account to access. For example, your emails, or your private github repositories, etc.

This allows you to provide AI applications with context and abilities that it would normally not have access to. You could, for example, have an AI application use some code in a private repo as context to answer your questions, or have it write and send an email on your behalf, after you review it. It's kind of like this:

![A diagram of how MCP works in 3 steps: 1) AI app asks for permission to connect to gmail, 2) user grants permission, 3) AI app can now access gmail data](https://p176.p0.n0.cdn.zight.com/items/p9uyYBQL/5743e744-1c37-462c-92a6-2cf30c40d6be.png?v=eeadf50900b2781e996c0f4752dd8949)

We think this is valuable because it enables people to use AI to access a bunch of extra information that it wasn't able to access before, and does so in a safe way where you as the user are in control over what it has access to and what it can do. We're excited to see what new AI use cases become possible as MCP adoption grows, and we built this library to try to help make it easier for people to integrate MCP into their applications.

### Client vs Server usage

There are two parties involved in MCP:

- The **client**, which is the one that wants to get access to another service. In the above example would be Claude, which wants to get access to Gmail.
- The **server**, which is the one that has something that a client wants access to. In the above example, this would be Gmail. This is sometimes referred to as the "resource server" or "MCP server".

This library has tools for both of these parties, so step one is to be clear on whether you are building a client or server. We'll address each of these use cases separately.

> _**NOTE:** In web development, the terms "client" and "server" are often used to refer to the frontend (browser) and backend (web server). This is not the case in this situation, so try not to confuse them!_

### Framework-Specific Documentation

For detailed implementation guides and examples specific to your framework, see:

- **[Express.js Integration](./express/README.md)** - Complete guide for building MCP servers with Express.js
- **[Hono Integration](./hono/README.md)** - Complete guide for building MCP servers with Hono and edge runtimes
- **[Next.js Integration](./next/README.md)** - Complete guide for building both MCP servers and clients with Next.js

Upgrading from 0.9.x? Every entry point was renamed in 0.10.0, with no deprecated aliases. The [changelog](./CHANGELOG.md) maps each old name, such as `mcpAuthClerk`, `protectedResourceHandlerClerk`, `authServerMetadataHandlerClerk`, `verifyClerkToken`, `@clerk/mcp-tools/feedback`, and `@clerk/mcp-tools/create-browser-session`, to its replacement.

### Table of Contents

- [Guide: building a server](#guide-building-a-server)
- [Guide: building a client](#guide-building-a-client)
- [Stores](#stores)
- [Reference docs](#reference-docs)

### Guide: building a server

If you are building a server that you'd like to introduce MCP support for, you will want to use the `@clerk/mcp-tools/server` import path. With Express, Hono, or Next.js, import from that framework's subpath instead (`@clerk/mcp-tools/express`, `@clerk/mcp-tools/hono`, or `@clerk/mcp-tools/next`): each one exports everything in `@clerk/mcp-tools/server` too.

#### Protected resource metadata

In order for the [most up to date authentication flow in the MCP spec](https://modelcontextprotocol.io/specification/draft/basic/authorization#2-6-authorization-flow-steps) to work correctly, your server will need to expose a static metadata file called "protected resource metadata", which is defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).

This library exposes a tool that can quickly generate such a metadata file for you. Here's an example of how to use it:

```ts
import { generateProtectedResourceMetadata } from '@clerk/mcp-tools/server';

const result = generateProtectedResourceMetadata({
  resourceUrl: 'https://myapp.com/current-route',
  authServerUrl: 'https://auth.example.com',
});
```

Return this result from `/.well-known/oauth-protected-resource` followed by your MCP endpoint's path, such as `/.well-known/oauth-protected-resource/mcp` for an endpoint at `/mcp` (RFC 9728 section 3). This is the URL the `401` challenge's `resource_metadata` points to. A route at the bare `/.well-known/oauth-protected-resource` describes only the origin, so its `resource` doesn't match an endpoint with a path.

If you are using [Clerk](https://clerk.com) for authentication in your app, pass your publishable key instead of `authServerUrl`. The authorization server is derived from the key. A key that isn't a Clerk publishable key throws a `Clerk error:`. `properties` can't set `resource`, which is always `resourceUrl` so that it matches the URL clients derived the metadata URL from (RFC 9728 section 3.3): setting it, even to `undefined`, throws a `Clerk error:`. Add `resource_documentation`, a page about your own MCP server, in `properties` if you have one:

```ts
import { generateProtectedResourceMetadata } from '@clerk/mcp-tools/server';

const result = generateProtectedResourceMetadata({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  resourceUrl: 'https://myapp.com/current-route',
  properties: { resource_documentation: 'https://myapp.com/docs/mcp' },
});
```

For framework-specific implementations of protected resource metadata handlers, see:

- [Express.js implementation](./express/README.md#protected-resource-metadata)
- [Hono implementation](./hono/README.md)
- [Next.js implementation](./next/README.md#protectedresourcemetadatahandler)

#### Authorization server metadata

An [older version of the MCP spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization#2-5-authorization-flow-steps) required MCP servers to publish a separate "authorization server metadata" document, defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414). Most deployments no longer need this endpoint when they publish protected resource metadata and use an authorization service with its own metadata endpoint. You may still need it for a custom or embedded authorization server or an older MCP client. With Clerk the route is optional: clients that follow RFC 9728 find Clerk's own metadata from the `authorization_servers` in your protected resource metadata. Mount it only to support clients that look for the metadata on your server's origin. Each adapter's `authorizationServerMetadataHandler()` relays Clerk's metadata, and answers with a JSON `502`, `{"error":"server_error"}`, when it can't be fetched.

If you use [Clerk](https://clerk.com) for authentication, fetch the metadata from your Clerk Frontend API and return it from your authorization server metadata endpoint.

```ts
import { fetchAuthorizationServerMetadata } from '@clerk/mcp-tools/server';

// Return this result from <your-app>/.well-known/oauth-authorization-server
const result = await fetchAuthorizationServerMetadata({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});
```

For framework-specific implementations, see:

- [Express.js implementation](./express/README.md#authorizationservermetadatahandler)
- [Hono implementation](./hono/README.md#authorizationservermetadatahandler)
- [Next.js implementation](./next/README.md#authorizationservermetadatahandler)

#### Creating an MCP endpoint

To create an MCP endpoint that handles the actual MCP protocol communication, you'll need to use framework-specific adapters, since each framework has its own way of handling request and response objects, which are critical parts of implementing the MCP protocol:

- **Express.js**: Use the `streamableHttpHandler` from `@clerk/mcp-tools/express` - see [Express.js guide](./express/README.md#mcp-request-handler)
- **Hono**: Use the `streamableHttpHandler` from `@clerk/mcp-tools/hono` - see [Hono guide](./hono/README.md)
- **Next.js**: Use Vercel's `mcp-handler` with `withMcpAuth` from `@clerk/mcp-tools/next` - see [Next.js guide](./next/README.md#building-an-mcp-server)

These adapters handle the MCP protocol details and integrate with your authentication system.

#### Step-up for your own tools

When a tool needs an OAuth scope that the access token lacks, the MCP server can answer `403` with `WWW-Authenticate: Bearer error="insufficient_scope", ...`. MCP clients answer that by asking the user to approve more scopes. MCP SDK 2.1 or later (`@modelcontextprotocol/server`, which Vercel's `mcp-handler` 2.x also uses) sends this challenge before the tool runs, from the `scopeChallenge` option of `registerTool`. `requireAdditionalScopes` from `@clerk/mcp-tools/server` (also exported from every adapter subpath) builds that option from the scopes the tool needs:

```ts
import { requireAdditionalScopes } from '@clerk/mcp-tools/server';

server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description: 'Lists the projects of the signed-in user.',
    inputSchema: {},
    scopeChallenge: requireAdditionalScopes('projects:read'),
  },
  async () => {
    // ...
  },
);
```

- Pass `resourceMetadataUrl` on the `authInfo` you give the SDK (for example `{ ...authInfo, resourceMetadataUrl }`). Without it, the challenge has no `resource_metadata`. `mcpAuth` in the Express and Hono adapters and `withMcpAuth` in the Next.js adapter set it for you.
- The challenge lists the granted scopes followed by the missing ones. Some MCP clients request exactly the challenged scopes, so listing only the missing ones could drop access that other tools need. The SDK's own `requireScopes` helper lists the required scopes only.
- Enable every scope your tools need for the OAuth application. Its scope settings and the user's approval decide what a token can get. `scopes_supported` in your protected resource metadata only guides what clients request: MCP clients request the scopes named in a challenge, and otherwise usually the whole `scopes_supported` list on first connection. A `401` names scopes only when your server adds them, as `mcp-handler`'s `withMcpAuth` does from its `requiredScopes`, and this package's `mcpAuth` and `withMcpAuth` do from `requiredScopes` and `challengeScopes`. Listing only baseline scopes in `scopes_supported` encourages clients to request extra scopes through step-up, though a client can still request them up front. When the `401` doesn't name scopes, listing a scope there makes most clients request it on first connection, which is usually the only way clients without step-up support ask for it.
- The SDK sends the challenge only over HTTP (`createMcpHandler` or the Streamable HTTP transport) and for requests with auth info. Elsewhere, including stdio, the tool runs without it.
- MCP SDK 1.x has no `scopeChallenge` option, and TypeScript rejects it there, so a tool on SDK 1.x must check its scopes itself. `streamableHttpHandler` runs whichever SDK's transport you pass it: in `@clerk/mcp-tools/hono`, pass `McpServer` and `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server` 2.1 or later, and the step-up challenge works through it. The Express handler is documented and tested with SDK 1.x's `StreamableHTTPServerTransport`.
- List each tool's `requireAdditionalScopes` scopes in `challengeScopes` too, so the client gets one challenge for everything it needs. When a token lacks a `requiredScopes` entry, the `403` from `mcpAuth` or `withMcpAuth` lists the granted scopes followed by every missing `requiredScopes` and `challengeScopes` entry, so after one reauthorization the tool's own challenge passes. Without that, the client reauthorizes for the `403`, then again for the tool. A token that lacks only `challengeScopes` entries is let through.
- `requireAdditionalScopes` throws a `Clerk error:` message when it is given no scopes or a scope that is not a valid OAuth scope token.
- `createBrowserSessionTool` sets this option from its `requiredScopes` for you, and leaves it out when `requiredScopes` is empty.

#### Public access: sign in only when needed

By default every request without a token gets the `401` challenge, so an MCP client signs in before it can connect. `publicAccess` names what a request without a token may do instead. A client can then connect, list tools, and call the tools you list without an account, and it is asked to sign in the first time it reaches anything else. Claude calls this "Sign in when needed" for a custom connector.

```ts
// Or from @clerk/mcp-tools/hono or @clerk/mcp-tools/next
import type { McpAuthOptions } from '@clerk/mcp-tools/express';

const mcpAuthOptions = {
  resourceUrl: 'https://mcp.example.com/mcp',
  // Asked for in the 401, so the first sign-in covers the protected tools
  challengeScopes: ['profile', 'email'],
  publicAccess: {
    methods: true,
    tools: ['search_docs'],
  },
} satisfies McpAuthOptions;
```

Pass the same object to `mcpAuth` (`withMcpAuth` in Next.js) and to `protectedResourceMetadataHandler`, which ignores `publicAccess`.

The example uses `challengeScopes`, not `requiredScopes`. `requiredScopes` makes every request with a token need those scopes, and answers a token without them with a `403`. `challengeScopes` only adds them to the challenges, the `401` and a `403` that `requiredScopes` causes, so the first sign-in asks for them without making them a condition of every request. Use `requiredScopes` for scopes no request may go without.

- `methods`: the protocol methods open without a token. `true` opens all of `initialize`, `server/discover`, `ping`, `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list`. A list opens only the ones it names. `initialize` covers the `notifications/initialized` notification that follows it. It never opens a call.
- `tools`: the tools a `tools/call` may name without a token. Each tool is listed by name, and no value opens every tool.
- `resources`: the resources a `resources/read` may ask for without a token. `true` opens every resource, and a list opens only the URIs it names. A URI is compared exactly as the client sends it, so a list cannot open the URIs of a resource template.
- `prompts`: the prompts a `prompts/get` may ask for without a token. `true` opens every prompt, and a list opens only the prompts it names.

Nothing is open unless it is listed, and without `publicAccess` every request without a token still gets the `401`.

- A request that carries a token is verified as usual, even for an open method, and a token that does not verify gets its `401`.
- A `POST` without a token passes only when every JSON-RPC message in its body is open. A batch with one protected message, a body that is not sent as `application/json`, and a body over 1 MiB all get the `401`. In Express, `express.json()` reads the body before `mcpAuth`, so its `limit` (100kb by default) is what bounds how much a request without a token makes the server buffer: set `express.json({ limit })` to the size you accept from anonymous clients. A body over 1 MiB still gets the `401`. For a chunked body Express measures the parsed body serialized again, which differs from the bytes sent by whitespace and number formatting, so only `express.json()`'s `limit` bounds the original bytes.
- The `401` for a protected call is the usual challenge, with `resource_metadata` and the `scope` from `requiredScopes` and `challengeScopes`. It is sent before the MCP SDK runs, which is what makes a client start authorization. A tool cannot send it: the SDK turns an error from a tool into a `200` result, which no client treats as a reason to sign in.
- A `GET` without a token gets a `405` with `Allow: POST` when `methods` opens `initialize` or `server/discover`. MCP clients open a `GET` stream once they have connected, and a `401` there would start authorization before the client reached anything protected. The `GET` has to reach `mcpAuth` for this, so route every method of the endpoint through it, as in `app.all('/mcp', ...)` in Express and Hono. In Next.js, export the wrapped handler as `GET` and `DELETE` as well as `POST`. From protocol revision 2026-07-28, clients open a `subscriptions/listen` `POST` instead, and the same condition opens it without a token, as long as every URI in its `resourceSubscriptions` is one `resources` opens. A listen that subscribes to any other resource gets the `401`.
- A `DELETE` without a token gets the `401`, as does any other request that isn't open. MCP clients send a `DELETE` only to end a session, and the stateless handlers never start one.
- `tasks/get`, `tasks/result`, and `tasks/cancel` always need a token, even for a task that a public tool started: a task ID alone doesn't show who may read or cancel the task. A client without a token gets the `401` for them.
- The `notifications/cancelled`, `notifications/progress`, and `notifications/roots/list_changed` messages pass whenever `publicAccess` opens anything. A client sends them about work already under way, for example when a call is cancelled or times out, and a `401` there would ask the user to sign in although they reached nothing protected. Any other notification from a client without a token still gets the `401`. `publicAccess` assumes a stateless server, as `streamableHttpHandler`, `createMcpHandler`, and `mcp-handler` run: these notifications are not checked against the caller, so on a stateful server a client without a token that knows a session ID and a request ID could cancel another user's request or report progress on it.
- An open list method shows its whole list. With `tools/list` open, anyone can read the name, description, and input schema of every tool, the protected ones included.
- A request that `publicAccess` lets through has no auth info, so a public tool cannot assume there is a user.
- A protected tool still declares the scopes it needs with `requireAdditionalScopes`, as in [Step-up for your own tools](#step-up-for-your-own-tools), so that a token without them gets the `403` step-up.
- A mistake in `publicAccess`, such as `tools/call` in `methods`, throws a `Clerk error:` at startup.

#### Collecting feedback from agents

Agents that use your MCP server sometimes get blocked, need a workaround, or find a tool confusing. `submitFeedbackTool` from `@clerk/mcp-tools/tools` adds a `submit_feedback` tool that agents can call to report it. Reports are stored on your Clerk instance and shown on the instance's **Feedback** tab in the Clerk Dashboard.

```ts
import { submitFeedbackTool } from '@clerk/mcp-tools/tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function createServer() {
  const server = new McpServer({ name: 'my-app', version: '1.0.0' });
  server.registerTool(...submitFeedbackTool({ secretKey: process.env.CLERK_SECRET_KEY! }));
  // ...register your own tools
  return server;
}
```

The tool works with both major versions of the MCP SDK: `@modelcontextprotocol/sdk` 1.x (`McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`) and `@modelcontextprotocol/server` 2.x (`McpServer` from `@modelcontextprotocol/server`). The registration line is the same. The tool's schemas must use the same `zod` copy as the MCP SDK, or its input schema doesn't type-check against `registerTool`. Keep `zod` on a version the SDK accepts (4.2 or later for SDK 2.x) and check that `npm ls zod` shows a single version.

- `secretKey` must be the secret key (`sk_...`) of the Clerk instance the reports belong to. `submitFeedbackTool` throws if it's empty, so a missing environment variable fails at startup.
- Agents describe the task, what kind of problem it was (`missing`, `broken`, `confusing`, or `idea`, the `FeedbackKind` type), how the task ended (`FeedbackImpact`), and what they tried and what went wrong. `SUBMIT_FEEDBACK_TOOL_NAME` names the tool before it is built.
- Each report names your server as its source: the request's host by default, or pass `server: { name, version }` to label it yourself.
- Each report names the agent from the client info its MCP client sends with the request, or otherwise from the HTTP `User-Agent` header. Generic HTTP libraries and browsers (such as `node` or `Mozilla`) aren't used as names, and clients that identify themselves only when they connect (common over stdio) appear without a name.
- When the request's auth info came from `toClerkAuthInfo` (for example through `mcpAuth` in the Express and Hono adapters or `withMcpAuth` from `@clerk/mcp-tools/next`, without `verifyToken`), the signed-in user's ID and the OAuth client ID are attached to each report. `toClerkAuthInfo` marks its result with `extra.verifiedBy: 'clerk'` (check it with `isClerkAuthInfo` from `@clerk/mcp-tools/server`); identity from any other verifier is not sent.
- Agents file reports without asking the user first. A report contains the agent's summary of what the user asked for, the tool calls it made, and any errors, and is linked to the user's ID when one is attached. Cover this in the privacy information you give your users.
- Clerk removes secrets it detects in reports and accepts up to 100 reports per instance per hour.
- On a public MCP endpoint without authentication, anyone can call this tool, submit misleading reports, and exhaust the instance's 100-report-per-hour limit. Protect it with authentication or other access controls where possible.
- If a report can't be stored, the tool tells the agent not to retry and logs the response status with `console.error`. Requests to Clerk time out after 10 seconds.
- Its error result names the failure in `_meta[ERROR_CODE_META_KEY]` (`ERROR_CODE_META_KEY` is exported from `@clerk/mcp-tools/tools`): `rate_limited` for Clerk's `429`, `rejected` for any other refusal, or `unconfirmed` after a timeout, a lost connection, or an unreadable success response, when Clerk may have stored the report.
- This module imports `zod` (3.25 or later, or 4), an optional peer dependency. List it in your app's own dependencies even though the MCP SDK depends on it too: a package manager that doesn't hoist dependencies, such as Yarn PnP or pnpm with an isolated layout, can't resolve the SDK's copy from `@clerk/mcp-tools`.

#### Signed-in browser links for agents

When an agent drives a browser for your user and lands on your app's sign-in page, `createBrowserSessionTool` from `@clerk/mcp-tools/tools` lets it get a one-time link that opens your app already signed in as that user. The `create_browser_session` tool takes the user from the verified MCP access token, never from tool input.

The link starts a session as the user, so the access token check in front of this tool must be strict: the token's audience must be your MCP server's resource URL. `withMcpAuth` from `@clerk/mcp-tools/next` and `mcpAuth` in the Express and Hono adapters check it against their `resourceUrl`. Here is a Next.js setup on the `withMcpAuth` route from the [Next.js guide](./next/README.md#building-an-mcp-server), with `mcp-handler` 2.x on `@modelcontextprotocol/server` 2.1 or later, so that the SDK can send the step-up challenge.

First, serve the protected resource metadata at the path form of the MCP endpoint, with the same `resourceUrl` the route passes to `withMcpAuth`. The metadata's `resource` is that URL. MCP clients send that `resource` when they request a token, and Clerk puts it in the token's `aud`, so the two must match. A metadata route at the root `/.well-known/oauth-protected-resource` advertises only the origin, and every token would then fail the audience check. Enable the scopes the tool requires for the OAuth application. List them in `scopes_supported` too: a client without step-up support requests that list on its first connection, so that is the only way it asks for them. See [Step-up for your own tools](#step-up-for-your-own-tools):

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import { metadataCorsHandler, protectedResourceMetadataHandler } from '@clerk/mcp-tools/next';

// List every scope the server's tools need, here the `requiredScopes` of the tool below.
const handler = protectedResourceMetadataHandler({
  resourceUrl: 'https://app.example.com/mcp',
  properties: { scopes_supported: ['browser_session'] },
});
const corsHandler = metadataCorsHandler();

export { handler as GET, corsHandler as OPTIONS };
```

Then the MCP route. `createBrowserSessionTool` sets the SDK's `scopeChallenge` registration option, so the SDK sends the step-up challenge before the tool runs, and the route needs no scope code:

```ts
// app/mcp/route.ts
import { withMcpAuth } from '@clerk/mcp-tools/next';
import { browserSessionInstructions, createBrowserSessionTool } from '@clerk/mcp-tools/tools';
import { createMcpHandler } from 'mcp-handler';

const APP_URL = 'https://app.example.com/dashboard';

// A custom scope for this tool only. Not a scope that most clients get, such as `profile`: see the notes below.
const BROWSER_SESSION_SCOPES = ['browser_session'] as const;

// Built once at module scope, so a bad configuration fails at startup instead of on every request.
const browserSessionTool = createBrowserSessionTool({
  secretKey: process.env.CLERK_SECRET_KEY!,
  destinationUrl: APP_URL,
  requiredScopes: BROWSER_SESSION_SCOPES,
});

const handler = createMcpHandler(
  (server) => {
    server.registerTool(...browserSessionTool);
    // ...register your own tools
  },
  { instructions: browserSessionInstructions(APP_URL) },
);

// Tokens must carry this URL in their `aud` claim. `withMcpAuth` also sets the `resourceMetadataUrl` the step-up
// challenge needs.
const authHandler = withMcpAuth(handler, { resourceUrl: 'https://app.example.com/mcp' });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
```

- Pass `browserSessionInstructions(destinationUrl)` as the server `instructions`. Some MCP clients, such as Codex, show agents only the server instructions until the agent searches for a tool, so without them an agent may open your app in a browser and stop at the sign-in page.
- Check the audience. Without an `audience` check, any OAuth access token that your Clerk instance issued, to any OAuth application and for any purpose, can call this tool. Your Clerk instance must issue the `aud` claim in its OAuth access tokens. Clerk turns it on when you add your first MCP server to the instance in the Clerk Dashboard; see [Build an MCP server](https://clerk.com/docs/guides/ai/mcp/build-mcp-server). Require `@clerk/backend` 3.19.0 (`@clerk/nextjs` 7.9.5, `@clerk/express` 2.1.70) or later (see [clerk/javascript#9724](https://github.com/clerk/javascript/pull/9724)). Before those versions, a JWT access token without an `aud` claim and an opaque OAuth access token both pass the `audience` check, and only a JWT with a different `aud` is rejected. `mcpAuth` in the Express and Hono adapters and `withMcpAuth` in the Next.js adapter, without `verifyToken`, check the audience against their `resourceUrl` option. To confirm that the check works, send a token that was issued to another OAuth application of the same instance, or for another resource: the MCP route must answer `401`.
- If you verify tokens yourself instead of with `withMcpAuth` or `mcpAuth`, call `authenticateRequest` with an `audience` equal to your resource URL and convert the result with `toClerkAuthInfo`. Set the tool's `requiredScopes` to the OAuth scopes the access token must carry. `requiredScopes` is required. `[]` is accepted, but then every token that passes the audience check can create a link.
- Require a dedicated scope for this tool, such as a custom scope named `browser_session`, not a scope that nearly every client gets, such as `profile` or `email`. The link signs a browser in to your app as the user, so the scope is how the user approves that for a given MCP client. With a common scope, every MCP client the user connects can open your app as them. `restricted` does not narrow this for your own backend: only Clerk's Frontend API enforces it, and your backend sees an ordinary signed-in session unless it checks for an agent session itself. Create the scope as a custom OAuth scope on your Clerk instance, enable it for the OAuth applications that may use the tool, and keep it out of the scopes that clients get by default, so a client gets it only when the user approves it, for example through the step-up challenge.
- Step-up authorization (a `403` challenge that makes the MCP client ask the user to approve more scopes) needs `@modelcontextprotocol/server` 2.1 or later. The tool sets the SDK's `scopeChallenge` registration option, and `resourceMetadataUrl` must be on `authInfo`, as `withMcpAuth` sets it; without it the challenge has no `resource_metadata`. The challenge asks for the token's granted scopes plus the missing ones, so the new grant does not drop access that other tools need. The SDK's own `requireScopes` helper challenges for the listed scopes only.
- On `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/server` versions before 2.1 the tool still registers and works, but there is no step-up. On `@modelcontextprotocol/server` versions before 2.1 the tool also logs a one-time `Clerk warning:`. A token without the required scopes gets the tool's own error, which tells the agent to ask the user to reconnect the MCP server and approve those scopes. The tool refuses before it calls Clerk. `createBrowserSessionTool` also throws a `Clerk error:` message when a scope is not a valid OAuth scope token or looks like a Clerk key (`sk_...`, `pk_...`).
- Your MCP server and your app must use the same Clerk instance. `secretKey` is that instance's secret key (`sk_...`), and `destinationUrl` must be on a domain of that instance.
- The agent can pass an absolute `path` such as `/settings` (with optional query and hash). It replaces the path of `destinationUrl`, and the tool refuses anything that would leave the app.
- The link is a bearer credential: anyone who has it before it is used or expires can sign in as the user. The tool never puts it in error messages, but its text result contains the link so that the agent can open it. Never log it, and treat MCP client and gateway logs of tool results as credentials.
- `restricted` (default `true`) limits the session the link starts. Clerk's Frontend API refuses these writes from that session: touch, switching the active session or organization, sign-out, writes to the user's own profile and organizations, reverification, and OAuth consent and approval. The one exception is refreshing its own session token. Clerk enforces this restriction, not your app's own backend: your backend sees an ordinary signed-in session unless it checks for an agent session itself. Pass `restricted: false` for an ordinary session. When Clerk does not confirm the restriction in its response, for example on a Clerk Backend API that does not support it yet, the tool revokes the new session link on a best-effort basis, refuses to return it, and fails with the error code `restricted_not_applied`. The log line names the `agent_task_id` when it is a well-formed ID. A malformed ID is never logged. It is still revoked when it can safely go in the revoke request's path; otherwise the log line says `revoke_skipped`, and the unused link expires on its own.
- Optional settings: `sessionMaxDurationInSeconds` sets the maximum length, in seconds, of the session the link starts. Clerk's default is 30 minutes, and a larger value makes the session longer. `agentName`, `apiUrl`, and `fetch` are also available. Requests to Clerk time out after 10 seconds.
- `organizationId` sets the organization each link starts in, as described for `createBrowserSession` below. Pass an ID, or a function that returns one for each call from the request's verified auth info, such as the workspace the user connected. The function may be synchronous or `async`, and runs only after the auth, scope, and path checks pass. Return `undefined` to leave the organization to Clerk. When it throws, or returns anything but a non-empty string or `undefined`, the tool refuses with `organization_lookup_failed` and logs the error's name and its `code` property, never its message. To give the agent a more specific reason, throw a `BrowserSessionError`, such as `new BrowserSessionError('organization_rejected', 'No workspace')`, and the tool answers with that code. A static `organizationId` must be a non-empty string.
- To customise the tool, override parts of the config it returns instead of building your own, and wrap its callback to add logging. Every error result carries a code in `_meta[ERROR_CODE_META_KEY]`, the key `'clerk.com/error_code'`: the `BrowserSessionErrorCode` when the tool can name the failure, or `unexpected_error`. A wrapper can tell, for example, `rate_limited` from `invalid_path` without reading the text. Use `CREATE_BROWSER_SESSION_TOOL_NAME` to allowlist the tool or name it before it is built.

  ```ts
  import { createBrowserSessionTool, ERROR_CODE_META_KEY } from '@clerk/mcp-tools/tools';

  const [name, config, callback] = createBrowserSessionTool(options);
  server.registerTool(
    name,
    { ...config, description: `${config.description} ${READ_ONLY_NOTE}` },
    async (input, extra) => {
      const result = await callback(input, extra);
      if (result.isError) log(name, result._meta?.[ERROR_CODE_META_KEY]);
      return result;
    },
  );
  ```

- To create a link outside of an MCP tool, use `createBrowserSession({ authInfo, path, taskDescription, organizationId }, options)` from `@clerk/mcp-tools/tools`. It resolves to `{ url, agentTaskId, redirectUrl }`. `organizationId` is optional and sets the organization the session starts in. With `restricted`, it is also the only organization the session can use. Without it, Clerk uses the user's last active organization. When you pass it, the link is refused with `restricted_not_applied` unless Clerk confirms that organization, and it fails with `organization_rejected` when the user does not belong to the organization, or when the instance requires one and none applies. It rejects with a `Clerk error:` message when the options cannot work. When it rejects with a `BrowserSessionError`, `error.code` says why (for example `insufficient_scope`, with the scopes in `error.missingScopes`, or `restricted_not_applied`).
- The tool works with `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/server` 2.x, with the same registration line. This module imports `zod` (3.25 or later, or 4), an optional peer dependency. List it in your app's own dependencies even though the MCP SDK depends on it too: a package manager that doesn't hoist dependencies, such as Yarn PnP or pnpm with an isolated layout, can't resolve the SDK's copy from `@clerk/mcp-tools`. The tool's schemas must use the same `zod` copy as the MCP SDK: keep `zod` on a version the SDK accepts (4.2 or later for SDK 2.x) and check that `npm ls zod` shows a single version.

### Guide: building a client

The first step to building MCP compatibility into your AI application is allowing your users to connect with an MCP service. This can be kicked off simply with the URL of an MCP-compatible server, like `https://example.com/mcp`. Normally, your app would implement a text field where the user can enter an MCP endpoint, or have a pre-built integration where clicking a button would trigger an MCP connection flow with a baked-in endpoint URL.

The process of actually making the MCP connection using the SDK, however, is fairly arduous, so we expose some tools that can help make this easier. They run on the MCP SDK 1.x, which `@clerk/mcp-tools/client` needs installed:

```bash
npm install @clerk/mcp-tools @modelcontextprotocol/sdk
```

#### Framework-agnostic client creation

Here's how you can create an MCP client using the core utilities:

```ts
import { createDynamicallyRegisteredMcpClient } from '@clerk/mcp-tools/client';
import { createRedisStore } from '@clerk/mcp-tools/stores/redis';

// Create a persistent store (use appropriate store for your environment)
const store = createRedisStore({
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASSWORD,
});

export async function initializeMCPConnection(mcpEndpoint: string) {
  const { connect, sessionId } = await createDynamicallyRegisteredMcpClient({
    mcpEndpoint,
    oauthScopes: 'openid profile email',
    oauthRedirectUrl: 'https://yourapp.com/oauth_callback',
    oauthClientUri: 'https://yourapp.com',
    mcpClientName: 'My App MCP Client',
    mcpClientVersion: '0.0.1',
    redirect: (url: string) => {
      // Implement redirect logic for your framework
      window.location.href = url;
    },
    store,
  });

  // Connect to the MCP endpoint
  await connect();

  return { sessionId };
}
```

#### OAuth callback handling

After the user completes the OAuth flow, you'll need to handle the callback:

```ts
import { completeOAuth } from '@clerk/mcp-tools/client';

export async function handleOAuthCallback(code: string, state: string) {
  const result = await completeOAuth({
    state,
    code,
    store,
  });

  // OAuth flow is now complete
  return result;
}
```

#### Making MCP tool calls

Once authentication is complete, you can call MCP tools:

```ts
import { getMcpClientBySessionId } from '@clerk/mcp-tools/client';

export async function callMCPTool(sessionId: string, toolName: string, args: any) {
  const { client, connect } = await getMcpClientBySessionId({
    sessionId,
    store,
  });

  await connect();

  const toolResponse = await client.callTool({
    name: toolName,
    arguments: args,
  });

  return toolResponse;
}
```

For complete framework-specific implementations with working examples, see:

- [Next.js client guide](./next/README.md#building-an-mcp-client)

### Stores

In order to implement MCP functionality in a client, persistent storage is required. This is because:

- The MCP flow operates across a minimum of three distinct server endpoints (initialization of MCP client, OAuth callback, MCP request), and these server endpoints could be deployed to distinct serverless/edge functions without a shared memory pool.
- Since the MCP connection is intended to be long-running, it must maintain a "session". Relying on in-memory storage for long-running sessions is generally a very bad idea ™️, since it would bloat memory requirements indefinitely as the app scales, and any sort of clearing of memory like a server restart would immediately invalidate all sessions.

As such, each of the client functions require that you pass in a store adapter. There are several built-in store adapters available:

#### File System Store (Development)

```ts
import { createFsStore } from '@clerk/mcp-tools/stores/fs';

const store = createFsStore();
```

This uses a temporary file and is fast, easy, and adequate for local development and testing. However, it's not suitable for production since the file could be deleted at any time.

#### Production Stores

For production environments, use one of these persistent stores:

##### Redis Store

```ts
import { createRedisStore } from '@clerk/mcp-tools/stores/redis';

// `host`, `port`, `password`, `db`, and `tls` configure the connection
const store = createRedisStore({
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASSWORD,
});
```

##### Postgres Store

```ts
import { createPostgresStore } from '@clerk/mcp-tools/stores/postgres';

const store = createPostgresStore({
  connectionString: process.env.DATABASE_URL,
});
```

##### SQLite Store

```ts
import { createSqliteStore } from '@clerk/mcp-tools/stores/sqlite';

const store = createSqliteStore({
  dbPath: './mcp-sessions.db',
});
```

#### Custom Store Implementation

If you wish to use a different kind of store, you can implement your own by complying with this simple interface:

```ts
type JsonSerializable =
  | null
  | boolean
  | number
  | string
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

interface McpClientStore {
  write: (key: string, data: JsonSerializable) => Promise<void>;
  read: (key: string) => Promise<JsonSerializable>;
}
```

The built-in stores have a few extra methods that may be useful, but only `read` and `write` are required for this to work.

### Reference docs

The above examples are more of a _guide_ for how to implement the tools, but for those digging deeper, this section covers each tool that is exposed out of this package, what it can take in as arguments, and what it will return.

#### Scope: `@clerk/mcp-tools/client`

- `createKnownCredentialsMcpClient`
  - **Description:** If dynamic client registration is not desirable, and your interface can collect a client id and secret from an existing OAuth client, you can create a MCP client with this function. Though it does increase friction in the user experience, we recommend allowing MCP services that do not enable dynamic client registration, since it comes with several security/fraud risks that not every provider wants to take on.
  - **Arguments**:

    ```ts
    interface CreateKnownCredentialsMcpClientOptions {
      /**
       * OAuth client id, expected to be collected via user input
       */
      clientId: string;
      /**
       * OAuth client secret, expected to be collected via user input
       */
      clientSecret: string;
      /**
       * OAuth redirect URL - after the user consents, this route will get
       * back the authorization code and state.
       */
      oauthRedirectUrl: string;
      /**
       * OAuth scopes that you'd like to request access to
       */
      oauthScopes?: string;
      /**
       * The endpoint of the MCP service, expected to be collected via user input
       */
      mcpEndpoint: string;
      /**
       * Name passed to the client created by the MCP SDK
       * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
       */
      mcpClientName: string;
      /**
       * Version number passed to the client created by the MCP SDK
       * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
       */
      mcpClientVersion: string;
      /**
       * A function that, when called with a url, will redirect to the given url
       */
      redirect: (url: string) => void;
      /**
       * A persistent store for auth data
       * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
       */
      store: McpClientStore;
    }
    ```

  - **Return Type:**

    ```ts
    interface McpClientConnection {
      /**
       * Represents a session associated with the connected MCP service endpoint.
       */
      sessionId: string;
      /**
       * Connects to the MCP service. Resolves once the connection is initialized.
       */
      connect: () => Promise<void>;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/streamableHttp.ts#L119
       */
      transport: StreamableHTTPClientTransport;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/index.ts#L81
       */
      client: Client;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/auth.ts#L13
       */
      authProvider: OAuthClientProvider;
    }
    ```

- `createDynamicallyRegisteredMcpClient`
  - **Description:** Creates a new MCP client given only an MCP endpoint url. Registers an OAuth client with the authorization server on-demand via [OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591).
  - **Arguments**:

    ```ts
    interface CreateDynamicallyRegisteredMcpClientOptions {
      /**
       * The endpoint of the MCP service, expected to be collected via user input
       */
      mcpEndpoint: string;
      /**
       * OAuth redirect URL - after the user consents, this route will get
       * back the authorization code and state.
       */
      oauthRedirectUrl: string;
      /**
       * The name of the OAuth client to be created with the authorization server
       */
      oauthClientName?: string;
      /**
       * The URI of the OAuth client to be created with the authorization server
       */
      oauthClientUri?: string;
      /**
       * OAuth scopes that you'd like to request access to
       */
      oauthScopes?: string;
      /**
       * Whether the OAuth client is public or confidential
       * @see https://datatracker.ietf.org/doc/html/rfc6749#section-2.1
       */
      oauthPublicClient?: boolean;
      /**
       * Name passed to the client created by the MCP SDK
       * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
       */
      mcpClientName: string;
      /**
       * Version number passed to the client created by the MCP SDK
       * @see https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients
       */
      mcpClientVersion: string;
      /**
       * A function that, when called with a url, will redirect to the given url
       */
      redirect: (url: string) => void;
      /**
       * A persistent store for auth data
       * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
       */
      store: McpClientStore;
    }
    ```

  - **Return Type:**

    ```ts
    interface McpClientConnection {
      /**
       * Represents a session associated with the connected MCP service endpoint.
       */
      sessionId: string;
      /**
       * Connects to the MCP service. Resolves once the connection is initialized.
       */
      connect: () => Promise<void>;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/streamableHttp.ts#L119
       */
      transport: StreamableHTTPClientTransport;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/index.ts#L81
       */
      client: Client;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/auth.ts#L13
       */
      authProvider: OAuthClientProvider;
    }
    ```

- `getMcpClientBySessionId`
  - **Description:** Given an existing session id, constructs a MCP client that matches the information used to create the client/session initially. Intended to be used in OAuth callback routes and any subsequent MCP calls once the service has been initialized.
  - **Arguments**:

  ```ts
  interface GetMcpClientBySessionIdOptions {
    /**
     * The session id to retrieve the client details for
     */
    sessionId: string;
    /**
     * A persistent store for auth data
     * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
     */
    store: McpClientStore;
    /**
     * If using this function in the OAuth callback route, pass in the state to
     * ensure that PKCE can run correctly.
     */
    state?: string;
  }
  ```

  - **Return Type:**

    ```ts
    interface McpClientConnection {
      /**
       * Represents a session associated with the connected MCP service endpoint.
       */
      sessionId: string;
      /**
       * Connects to the MCP service. Resolves once the connection is initialized.
       */
      connect: () => Promise<void>;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/streamableHttp.ts#L119
       */
      transport: StreamableHTTPClientTransport;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/index.ts#L81
       */
      client: Client;
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/auth.ts#L13
       */
      authProvider: OAuthClientProvider;
    }
    ```

- `completeOAuth`
  - **Description:** Designed to be used in the OAuth callback route. Passing in the code, state, and your store will finish the auth process
  - **Arguments:**

    ```ts
    interface CompleteOAuthOptions {
      /**
       * The authorization code returned from the auth provider via querystring.
       * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1
       */
      code: string;
      /**
       * The state returned from the auth provider via querystring.
       * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.1
       */
      state: string;
      /**
       * A persistent store for auth data
       * @see https://github.com/clerk/mcp-tools?tab=readme-ov-file#stores
       */
      store: McpClientStore;
    }
    ```

  - **Return Type:**

    ```ts
    interface CompleteOAuthResult {
      /**
       * Lower level primitive, likely not necessary for use
       * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/streamableHttp.ts#L119
       */
      transport: StreamableHTTPClientTransport;
      /**
       * Represents a session associated with the connected MCP service endpoint.
       */
      sessionId: string;
    }
    ```

#### Scope: `@clerk/mcp-tools/server`

- `generateProtectedResourceMetadata`
  - **Description:** Generates OAuth 2.0 Protected Resource Metadata as defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728). This metadata helps OAuth clients understand how to authenticate with your resource server. Pass either your Clerk publishable key, from which the authorization server URL is derived, or the URL of any other authorization server. Passing both, or neither, is a type error. `resource` is always `resourceUrl` (RFC 9728 section 3.3): a `properties` object with its own `resource` key, even one set to `undefined`, throws a `Clerk error:`, as the `protectedResourceMetadataHandler`s do.
  - **Arguments:**

    ```ts
    type GenerateProtectedResourceMetadataOptions =
      | {
          /**
           * Your Clerk publishable key (e.g., pk_test_... or pk_live_...).
           */
          publishableKey: string;
          /**
           * URL of the resource server that the metadata applies to
           */
          resourceUrl: string;
          /**
           * Additional properties to include in the metadata. They cannot set `resource`.
           */
          properties?: Record<string, any>;
        }
      | {
          /**
           * URL of the OAuth authorization server
           */
          authServerUrl: string;
          /**
           * URL of the resource server that the metadata applies to
           */
          resourceUrl: string;
          /**
           * Additional properties to include in the metadata. They cannot set `resource`.
           */
          properties?: Record<string, any>;
        };
    ```

  - **Return Type:**

    ```ts
    {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: ['header'];
      [key: string]: any; // Additional properties if provided, such as resource_name
    }
    ```

- `fetchAuthorizationServerMetadata`
  - **Description:** Fetches OAuth 2.0 Authorization Server Metadata from Clerk's servers based on your publishable key. This returns the actual metadata from Clerk's authorization server rather than generating it locally.
  - **Arguments:**

    ```ts
    interface FetchAuthorizationServerMetadataParams {
      /**
       * Your Clerk publishable key (e.g., pk_test_... or pk_live_...)
       */
      publishableKey: string;
    }
    ```

  - **Return Type:**

    ```ts
    Promise<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      userinfo_endpoint: string;
      jwks_uri: string;
      registration_endpoint?: string;
      scopes_supported: string[];
      response_types_supported: string[];
      response_modes_supported: string[];
      grant_types_supported: string[];
      subject_types_supported: string[];
      id_token_signing_alg_values_supported: string[];
      token_endpoint_auth_methods_supported: string[];
      claims_supported: string[];
      code_challenge_methods_supported: string[];
      [key: string]: any; // Additional metadata from Clerk
    }>;
    ```

- `isClerkAuthInfo`
  - **Description:** Returns `true` when an `AuthInfo` object came from `toClerkAuthInfo`, which marks its result with `extra.verifiedBy: 'clerk'` and a non-empty `extra.userId`. Use it to tell Clerk user and client ids apart from ones produced by a custom verifier. It is a type guard: after the check, TypeScript knows `authInfo.extra.userId` is a string. `toClerkAuthInfo` also keeps Clerk's own auth object for the token on `extra.auth`, typed `ClerkOAuthAuth | undefined` (it is missing from auth info built by hand). It is the object Clerk returned, and `ClerkOAuthAuth` types its `id` (empty for a JWT access token without a `jti`), `subject`, `userId`, `clientId`, `scopes`, `tokenType`, `isAuthenticated`, and `getToken()`. Clerk's `has()` and `debug` are not typed. For an OAuth token, `has()` always returns `false`, so check `scopes` instead.
  - **Params:** `authInfo: AuthInfo | undefined`
  - **Returns:** `authInfo is ClerkAuthInfo` (`ClerkAuthInfo` and `ClerkOAuthAuth` are also exported)

- `requireAdditionalScopes`
  - **Description:** Builds the `scopeChallenge` registration option of MCP SDK 2.1 or later for a tool that needs `requiredScopes`. Before the tool runs, the SDK answers a token that lacks some of them with a `403` step-up challenge for the granted scopes followed by the missing ones. A request without auth info is left to the tool. SDK 1.x has no such option. See [Step-up for your own tools](#step-up-for-your-own-tools).
  - **Params:** `...requiredScopes: string[]`, one or more scopes as separate arguments
  - **Returns:** the function to pass as the `scopeChallenge` option, `(context: { authInfo?: AuthInfo }) => { scopes: readonly [string, ...string[]] } | undefined`

- `toClerkAuthInfo`
  - **Description:** Converts Clerk's auth object for an already verified OAuth access token into the MCP SDK's `AuthInfo`, marked with `extra.verifiedBy: 'clerk'`. It verifies nothing itself: pass the result of `auth({ acceptsToken: 'oauth_token' })` or of a request state's `toAuth()`. Use it when you verify tokens yourself instead of with `mcpAuth` or `withMcpAuth`.
  - **Params:** `auth`, Clerk's auth object; `token: string | undefined`, the access token it came from
  - **Returns:** `ClerkAuthInfo | undefined`, `undefined` when there is no token or Clerk did not authenticate it

- `matchResourceUrl`
  - **Description:** The URL from a `resourceUrl` option that a request is for: `resourceUrl` itself when it is one URL, or the listed URL with the request's origin. It is the rule `mcpAuth`, `withMcpAuth`, and `protectedResourceMetadataHandler` apply, so a metadata route of your own can keep its `resource` identical to the URL they check. Answer `421` when it returns `undefined`.
  - **Params:** `resourceUrl: string | readonly string[]` (the `McpResourceUrl` type), `requestUrl: string | URL`
  - **Returns:** `string | undefined`

- `McpAuthError`
  - **Description:** The error `mcpAuth` and `withMcpAuth` raise when the token could not be verified at all, for example when `verifyToken` throws or Clerk is unreachable, so the client keeps its token instead of getting a challenge. `reason` is `'verification_failed'`, `cause` is the verifier's error, and `status` is the `429` or `5xx` status Clerk's Backend API answered with, or `undefined`. Express answers JSON with that status, or `500`, and logs the error with `console.error`. Hono throws it to `app.onError`, whose default handler answers the same way, and Next.js throws it to `onRequestError` and answers an empty `500`.

- `McpTokenVerificationError`
  - **Description:** What a verifier reported for a token it did not accept. Clerk verification creates one from Clerk's `reason` (its `code`, such as `token-invalid`) and `message`, and it is the `cause` of an `invalid_token` failure (`McpAuthFailure`) or of an `McpAuthError`. A `verifyToken` function can throw one to reject a token with its own code. It is never sent to the client.
  - **Params:** `new McpTokenVerificationError(code: string, message: string, options?: { status?: number })`

- Types: `McpResourceUrl` (one URL or a list), `PublicAccess` (the `publicAccess` option, see [Public access](#public-access-sign-in-only-when-needed)), `McpPublicMethod`, and `McpAuthFailure` (why `mcpAuth` answered a request itself, with its `reason` and, for `invalid_token`, the `cause`).

- `metadataCorsHeaders`
  - **Description:** Pre-configured CORS headers for OAuth metadata endpoints. These headers allow cross-origin requests to your OAuth metadata endpoints, which is necessary for web-based MCP clients.
  - **Value:**

    ```ts
    {
      "Access-Control-Allow-Origin": "*";
      "Access-Control-Allow-Methods": "GET, OPTIONS";
      "Access-Control-Allow-Headers": "*";
      "Access-Control-Max-Age": "86400";
    }
    ```

For detailed documentation on server utilities and framework-specific implementations, see:

- [Express.js server guide](./express/README.md)
- [Hono server guide](./hono/README.md)
- [Next.js server guide](./next/README.md#building-an-mcp-server)

#### Scope: `@clerk/mcp-tools/tools`

Needs `zod` in your app's own dependencies; see [Collecting feedback from agents](#collecting-feedback-from-agents).

- `submitFeedbackTool(options)`: the `submit_feedback` tool, as arguments for `server.registerTool(...)`. `submitFeedback` sends one report without a tool, and rejects with a `FeedbackSubmissionError` (with `status`) when Clerk refuses it. `SUBMIT_FEEDBACK_TOOL_NAME` is the tool's name. See [Collecting feedback from agents](#collecting-feedback-from-agents).
- `createBrowserSessionTool(options)`: the `create_browser_session` tool, as arguments for `server.registerTool(...)`. `createBrowserSession` creates one link without a tool and rejects with a `BrowserSessionError`, whose `code` is a `BrowserSessionErrorCode`. `browserSessionInstructions(destinationUrl)` builds the server instructions, and `CREATE_BROWSER_SESSION_TOOL_NAME` is the tool's name. See [Signed-in browser links for agents](#signed-in-browser-links-for-agents).
- `ERROR_CODE_META_KEY`: `'clerk.com/error_code'`, the `_meta` key that holds the code of every error result both tools return.

#### Framework-Specific Utilities

For framework-specific utilities and handlers, see:

- **Express.js**: See [Express.js reference documentation](./express/README.md)
- **Hono**: See [Hono reference documentation](./hono/README.md)
- **Next.js**: See [Next.js reference documentation](./next/README.md)
