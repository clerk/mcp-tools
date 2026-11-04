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

### Table of Contents

- [Guide: building a server](#guide-building-a-server)
- [Guide: building a client](#guide-building-a-client)
- [Stores](#stores)
- [Reference docs](#reference-docs)

### Guide: building a server

If you are building a server that you'd like to introduce MCP support for, you will want to use the `@clerk/mcp-tools/server` import path.

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

You will want to set up a route at `.well-known/oauth-protected-resource` and make sure to return this result from that route on your server.

If you are using [Clerk](https://clerk.com) for authentication in your app, we have a helper that makes this easier:

```ts
import { generateClerkProtectedResourceMetadata } from '@clerk/mcp-tools/server';

const result = generateClerkProtectedResourceMetadata({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  resourceUrl: 'https://myapp.com/current-route',
});
```

For framework-specific implementations of protected resource metadata handlers, see:

- [Express.js implementation](./express/README.md#protected-resource-metadata)
- [Hono implementation](./hono/README.md)
- [Next.js implementation](./next/README.md#protectedresourcehandler)

#### Authorization server metadata

> **NOTE:** This is not yet fully implemented

An [older version of the MCP spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization#2-5-authorization-flow-steps) required MCP servers to publish a separate "authorization server metadata" document, defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414). Most deployments no longer need this endpoint when they publish protected resource metadata and use an authorization service with its own metadata endpoint. You may still need it for a custom or embedded authorization server or an older MCP client.

If you use [Clerk](https://clerk.com) for authentication, fetch the metadata from your Clerk Frontend API and return it from your authorization server metadata endpoint.

```ts
import { fetchClerkAuthorizationServerMetadata } from '@clerk/mcp-tools/server';

// Return this result from <your-app>/.well-known/oauth-authorization-server
const result = await fetchClerkAuthorizationServerMetadata({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});
```

For framework-specific implementations, see:

- [Express.js implementation](./express/README.md)
- [Hono implementation](./hono/README.md)
- [Next.js implementation](./next/README.md#authservermetadatahandlerclerk)

#### Creating an MCP endpoint

To create an MCP endpoint that handles the actual MCP protocol communication, you'll need to use framework-specific adapters, since each framework has its own way of handling request and response objects, which are critical parts of implementing the MCP protocol:

- **Express.js**: Use the `streamableHttpHandler` from `@clerk/mcp-tools/express` - see [Express.js guide](./express/README.md#mcp-request-handler)
- **Hono**: Use the `streamableHttpHandler` from `@clerk/mcp-tools/hono` - see [Hono guide](./hono/README.md)
- **Next.js**: Use Vercel's MCP adapter with Next.js route handlers - see [Next.js guide](./next/README.md#building-an-mcp-server)

These adapters handle the MCP protocol details and integrate with your authentication system.

#### Step-up for your own tools

When a tool needs an OAuth scope that the access token lacks, the MCP server can answer `403` with `WWW-Authenticate: Bearer error="insufficient_scope", ...`. MCP clients answer that by asking the user to approve more scopes. MCP SDK 2.1 or later (`@modelcontextprotocol/server`) sends this challenge before the tool runs, from the `scopeChallenge` option of `registerTool`. `scopeChallengeFor` from `@clerk/mcp-tools/server` (also exported from `@clerk/mcp-tools/next`) builds that option from the scopes the tool needs:

```ts
import { scopeChallengeFor } from '@clerk/mcp-tools/server';

server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description: 'Lists the projects of the signed-in user.',
    inputSchema: {},
    scopeChallenge: scopeChallengeFor(['projects:read']),
  },
  async () => {
    // ...
  },
);
```

- Pass `resourceMetadataUrl` on the `authInfo` you give the SDK (for example `{ ...authInfo, resourceMetadataUrl }`). Without it, the challenge has no `resource_metadata`.
- The challenge lists the granted scopes followed by the missing ones. Some MCP clients request exactly the challenged scopes, so listing only the missing ones could drop access that other tools need. The SDK's own `requireScopes` helper lists the required scopes only.
- List every scope your tools need in `scopes_supported` of your protected resource metadata, and enable them for the OAuth application. MCP clients choose the scopes to request from the challenge, then from that list.
- Earlier SDK versions ignore the option, so a tool must still check its scopes itself. `createBrowserSessionTool` sets this option from its `requiredScopes` for you.
- `scopeChallengeFor` throws a `Clerk error:` message when a scope is not a valid OAuth scope token.

#### Collecting feedback from agents

Agents that use your MCP server sometimes get blocked, need a workaround, or find a tool confusing. `@clerk/mcp-tools/feedback` adds a `submit_feedback` tool that agents can call to report it. Reports are stored on your Clerk instance and shown on the instance's **Feedback** tab in the Clerk Dashboard.

```ts
import { submitFeedbackTool } from '@clerk/mcp-tools/feedback';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function createServer() {
  const server = new McpServer({ name: 'my-app', version: '1.0.0' });
  server.registerTool(...submitFeedbackTool({ secretKey: process.env.CLERK_SECRET_KEY! }));
  // ...register your own tools
  return server;
}
```

The tool works with both major versions of the MCP SDK: `@modelcontextprotocol/sdk` 1.x (`McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`) and `@modelcontextprotocol/server` 2.x (`McpServer` from `@modelcontextprotocol/server`). The registration line is the same. With SDK 2.x, install `zod` 4 (SDK 2.x requires it), so the tool's input schema type-checks against `registerTool`.

- `secretKey` must be the secret key (`sk_...`) of the Clerk instance the reports belong to. `submitFeedbackTool` throws if it's empty, so a missing environment variable fails at startup.
- Agents describe the task, what kind of problem it was (`missing`, `broken`, `confusing`, or `idea`), how the task ended, and what they tried and what went wrong.
- Each report names your server as its source: the request's host by default, or pass `server: { name, version }` to label it yourself.
- Each report names the agent from the client info its MCP client sends with the request, or otherwise from the HTTP `User-Agent` header. Generic HTTP libraries and browsers (such as `node` or `Mozilla`) aren't used as names, and clients that identify themselves only when they connect (common over stdio) appear without a name.
- When the request was authenticated with `verifyClerkToken` (for example through `mcpAuthClerk`), the signed-in user's ID and the OAuth client ID are attached to each report. `verifyClerkToken` marks its result with `extra.verifiedBy: 'clerk'` (check it with `isClerkAuthInfo` from `@clerk/mcp-tools/server`); identity from any other verifier is not sent.
- Agents file reports without asking the user first. A report contains the agent's summary of what the user asked for, the tool calls it made, and any errors, and is linked to the user's ID when one is attached. Cover this in the privacy information you give your users.
- Clerk removes secrets it detects in reports and accepts up to 100 reports per instance per hour.
- On a public MCP endpoint without authentication, anyone can call this tool, submit misleading reports, and exhaust the instance's 100-report-per-hour limit. Protect it with authentication or other access controls where possible.
- If a report can't be stored, the tool tells the agent not to retry and logs the response status with `console.error`. Requests to Clerk time out after 10 seconds.
- This module requires `zod` (3.25 or later, or 4), which the MCP SDK already needs.

#### Signed-in browser links for agents

When an agent drives a browser for your user and lands on your app's sign-in page, `@clerk/mcp-tools/create-browser-session` lets it get a one-time link that opens your app already signed in as that user. The `create_browser_session` tool takes the user from the verified MCP access token, never from tool input.

The link starts a session with the full permissions of the user, so the access token check in front of this tool must be strict. Verify the token with `authenticateRequest` and an `audience` equal to your MCP server's resource URL. Here is a Next.js setup on `@modelcontextprotocol/server` 2.1 or later, so that the SDK can send the step-up challenge. It replaces the `mcp-adapter` route from the [Next.js guide](./next/README.md#building-an-mcp-server). The tool also works behind the `mcp-adapter` route when that route checks the audience, but without step-up.

First, serve the protected resource metadata at the path form of the MCP endpoint, with `resource` set to the same URL the route uses as its `audience`. MCP clients send that `resource` when they request a token, and Clerk puts it in the token's `aud`, so the two must match. The guide's root metadata route advertises only the origin, and every token would then fail the audience check. The scopes the tool requires must be listed in `scopes_supported` and enabled for the OAuth application. MCP clients choose the scopes to request from the challenge, then from this list, so a reconnect cannot grant a scope that is not advertised here:

```ts
// app/.well-known/oauth-protected-resource/mcp/route.ts
import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandlerClerk,
} from '@clerk/mcp-tools/next';

// List every scope the server's tools need, here the `requiredScopes` of the tool below.
const handler = protectedResourceHandlerClerk({
  resource: 'https://app.example.com/mcp',
  scopes_supported: ['profile'],
});
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
```

Then the MCP route, here on `@modelcontextprotocol/server` 2.1 or later. `createBrowserSessionTool` sets the SDK's `scopeChallenge` registration option, so the SDK sends the step-up challenge before the tool runs, and the route needs no scope code:

```ts
// app/mcp/route.ts
import { verifyClerkToken } from '@clerk/mcp-tools/next';
import {
  browserSessionInstructions,
  createBrowserSessionTool,
} from '@clerk/mcp-tools/create-browser-session';
import { clerkClient } from '@clerk/nextjs/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

// The OAuth resource this server accepts. Tokens must carry it in their `aud` claim.
const MCP_RESOURCE_URL = 'https://app.example.com/mcp';
const RESOURCE_METADATA_URL = 'https://app.example.com/.well-known/oauth-protected-resource/mcp';

const APP_URL = 'https://app.example.com/dashboard';

// The OAuth scopes the tool needs.
const BROWSER_SESSION_SCOPES = ['profile'] as const;

// Built once at module scope, so a bad configuration fails at startup instead of on every request.
const browserSessionTool = createBrowserSessionTool({
  secretKey: process.env.CLERK_SECRET_KEY!,
  destinationUrl: APP_URL,
  requiredScopes: BROWSER_SESSION_SCOPES,
});

const mcpHandler = createMcpHandler(() => {
  const server = new McpServer(
    { name: 'my-app', version: '1.0.0' },
    { instructions: browserSessionInstructions(APP_URL) },
  );
  server.registerTool(...browserSessionTool);
  // ...register your own tools
  return server;
});

async function handler(req: Request) {
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  const clerk = await clerkClient();
  const requestState = await clerk.authenticateRequest(req, {
    acceptsToken: 'oauth_token',
    audience: MCP_RESOURCE_URL,
  });
  const authInfo = verifyClerkToken(requestState.toAuth(), token);
  if (!authInfo) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
      },
    });
  }

  // The SDK takes the challenge's `resource_metadata` from `resourceMetadataUrl`, which `verifyClerkToken` does not set.
  return mcpHandler.fetch(req, {
    authInfo: { ...authInfo, resourceMetadataUrl: RESOURCE_METADATA_URL },
  });
}

export { handler as GET, handler as POST, handler as DELETE };
```

- Pass `browserSessionInstructions(destinationUrl)` as the server `instructions`. Some MCP clients, such as Codex, show agents only the server instructions until the agent searches for a tool, so without them an agent may open your app in a browser and stop at the sign-in page.
- Check the audience. Without an `audience` check, any OAuth access token that your Clerk instance issued, to any OAuth application and for any purpose, can call this tool. Your Clerk instance must issue the `aud` claim in its OAuth access tokens. The `audience` option needs `@clerk/backend` 3.19.0, `@clerk/nextjs` 7.9.5, or `@clerk/express` 2.1.70 or later; older versions ignore it. On Express and Hono, use `createMcpAuthClerk` (see [Express and Hono](#express-and-hono)): the older `mcpAuthClerk` helpers do not check the audience. To confirm that the check works, send a token that was issued to another OAuth application of the same instance, or for another resource: the MCP route must answer `401`.
- Authenticate requests with `verifyClerkToken`, and set `requiredScopes` to the OAuth scopes the access token must carry. `requiredScopes` is required: pass `[]` when the tool needs no scope.
- Step-up authorization (a `403` challenge that makes the MCP client ask the user to approve more scopes) needs `@modelcontextprotocol/server` 2.1 or later. On `@modelcontextprotocol/server` 2.0 the tool logs one `Clerk warning:` per tool and still returns its own error. The tool sets the SDK's `scopeChallenge` registration option, and you must pass `resourceMetadataUrl` on `authInfo`, as above; without it the challenge has no `resource_metadata`. The challenge asks for the token's granted scopes plus the missing ones, so the new grant does not drop access that other tools need. The SDK's own `requireScopes` helper challenges for the listed scopes only.
- On `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/server` versions before 2.1 the tool still registers and works, but there is no step-up. A token without the required scopes gets the tool's own error, which tells the agent to ask the user to reconnect the MCP server and approve those scopes. The tool refuses before it calls Clerk. `createBrowserSessionTool` also throws a `Clerk error:` message when a scope is not a valid OAuth scope token.
- Your MCP server and your app must use the same Clerk instance. `secretKey` is that instance's secret key (`sk_...`), and `destinationUrl` must be on a domain of that instance.
- The agent can pass an absolute `path` such as `/settings` (with optional query and hash). It replaces the path of `destinationUrl`, and the tool refuses anything that would leave the app.
- The link is a bearer credential: anyone who has it before it is used or expires can sign in as the user. The tool never puts it in error messages, but its text result contains the link so that the agent can open it. Never log it, and treat MCP client and gateway logs of tool results as credentials.
- Optional settings: `sessionMaxDurationInSeconds` sets the maximum length, in seconds, of the session the link starts. Clerk's default is 30 minutes, and a larger value makes the session longer. `agentName`, `apiUrl`, and `fetch` are also available. Requests to Clerk time out after 10 seconds.
- To create a link outside of an MCP tool, use `createBrowserSession({ authInfo, path, taskDescription }, options)` from the same module. It resolves to `{ url, agentTaskId, redirectUrl }`. Use `validateBrowserSessionOptions(options)` to check the options at startup. When it throws a `BrowserSessionError`, `error.code` says why (for example `insufficient_scope`, with the scopes in `error.missingScopes`), and `browserSessionErrorMessage(error)` returns the message the tool gives the agent.
- The tool works with `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/server` 2.x, with the same registration line. This module requires `zod` (3.25 or later, or 4), which the MCP SDK already needs; with SDK 2.x, install `zod` 4.

##### Express and Hono

The `streamableHttpHandler` helpers for Express and Hono run on `@modelcontextprotocol/sdk` 1.x, which cannot send the step-up challenge. For this tool, serve MCP through the official `@modelcontextprotocol/server` 2.1 or later adapters, behind `createMcpAuthClerk`. It verifies the OAuth token with an `audience` check (a token for another resource gets `401`) and puts `resourceMetadataUrl` on the auth info, so you do not set either one yourself. Serve the protected resource metadata as in the Next.js setup above, with `resource` equal to `audience`. `createMcpAuthClerk` also reads the `aud` claim of a JWT access token itself, after Clerk verified it, and answers `401` unless `aud` overlaps `audience`, so a Clerk SDK older than the `audience` fix cannot let a token for another resource through. An opaque access token has no `aud` to read, so only Clerk's check covers it, and that needs `@clerk/backend` 3.19.0 or later (`@clerk/express` 2.1.70 or later). `createMcpAuthClerk` throws a `Clerk error:` message when `audience` is missing or empty. Pass `resourceMetadataUrl` only to replace the default, which is the URL the `401` response advertises; set it when a proxy changes the host or protocol seen by your server.

Install `@modelcontextprotocol/server`, the adapters you use, `@modelcontextprotocol/express` and `@modelcontextprotocol/node` for Express or `@modelcontextprotocol/hono` for Hono. Express needs no `clerkMiddleware()`, but it reads `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from the environment. The same `createBrowserSessionTool` registration works in both:

```ts
// Express
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  browserSessionInstructions,
  createBrowserSessionTool,
} from '@clerk/mcp-tools/create-browser-session';
import { createMcpAuthClerk } from '@clerk/mcp-tools/express';

const MCP_RESOURCE_URL = 'https://mcp.example.com/mcp';
const browserSession = {
  secretKey: process.env.CLERK_SECRET_KEY!,
  destinationUrl: 'https://app.example.com/',
  requiredScopes: ['email', 'user:org:read'],
};

const mcpHandler = toNodeHandler(
  createMcpHandler(() => {
    const server = new McpServer(
      { name: 'my-server', version: '1.0.0' },
      { instructions: browserSessionInstructions(browserSession.destinationUrl) },
    );
    server.registerTool(...createBrowserSessionTool(browserSession));
    return server;
  }),
);

const app = createMcpExpressApp();
app.post('/mcp', createMcpAuthClerk({ audience: MCP_RESOURCE_URL }), (req, res) =>
  mcpHandler(req, res, req.body),
);
```

```ts
// Hono
import { clerkMiddleware } from '@clerk/hono';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  browserSessionInstructions,
  createBrowserSessionTool,
} from '@clerk/mcp-tools/create-browser-session';
import { createMcpAuthClerk } from '@clerk/mcp-tools/hono';

const mcpHandler = createMcpHandler(() => {
  const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    { instructions: browserSessionInstructions(browserSession.destinationUrl) },
  );
  server.registerTool(...createBrowserSessionTool(browserSession));
  return server;
});

const app = createMcpHonoApp();
// The Hono helper reads the Clerk client that clerkMiddleware sets.
app.use('/mcp', clerkMiddleware());
app.all('/mcp', createMcpAuthClerk({ audience: MCP_RESOURCE_URL }), (c) =>
  mcpHandler.fetch(c.req.raw, { authInfo: c.get('mcpAuth') }),
);
```

`browserSession` and `MCP_RESOURCE_URL` are the same in both. Test the audience check as described in the list above. Without `clerkMiddleware()`, the Hono helper throws a `Clerk error:` message on the first request.

### Guide: building a client

The first step to building MCP compatibility into your AI application is allowing your users to connect with an MCP service. This can be kicked off simply with the URL of an MCP-compatible server, like `https://example.com/mcp`. Normally, your app would implement a text field where the user can enter an MCP endpoint, or have a pre-built integration where clicking a button would trigger an MCP connection flow with a baked-in endpoint URL.

The process of actually making the MCP connection using the SDK, however, is fairly arduous, so we expose some tools that can help make this easier.

#### Framework-agnostic client creation

Here's how you can create an MCP client using the core utilities:

```ts
import { createDynamicallyRegisteredMcpClient } from '@clerk/mcp-tools/client';
import { createRedisStore } from '@clerk/mcp-tools/stores/redis';

// Create a persistent store (use appropriate store for your environment)
const store = createRedisStore({ url: process.env.REDIS_URL });

export async function initializeMCPConnection(mcpEndpoint: string) {
  const { connect, sessionId } = createDynamicallyRegisteredMcpClient({
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
import { completeAuthWithCode } from '@clerk/mcp-tools/client';

export async function handleOAuthCallback(code: string, state: string) {
  const result = await completeAuthWithCode({
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
import { getClientBySessionId } from '@clerk/mcp-tools/client';

export async function callMCPTool(sessionId: string, toolName: string, args: any) {
  const { client, connect } = getClientBySessionId({
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

- [Express.js client guide](./express/README.md)
- [Next.js client guide](./next/README.md#building-an-mcp-client)

### Stores

In order to implement MCP functionality in a client, persistent storage is required. This is because:

- The MCP flow operates across a minimum of three distinct server endpoints (initialization of MCP client, OAuth callback, MCP request), and these server endpoints could be deployed to distinct serverless/edge functions without a shared memory pool.
- Since the MCP connection is intended to be long-running, it must maintain a "session". Relying on in-memory storage for long-running sessions is generally a very bad idea ™️, since it would bloat memory requirements indefinitely as the app scales, and any sort of clearing of memory like a server restart would immediately invalidate all sessions.

As such, each of the client functions require that you pass in a store adapter. There are several built-in store adapters available:

#### File System Store (Development)

```ts
import fsStore from '@clerk/mcp-tools/stores/fs';
```

This uses a temporary file and is fast, easy, and adequate for local development and testing. However, it's not suitable for production since the file could be deleted at any time.

#### Production Stores

For production environments, use one of these persistent stores:

##### Redis Store

```ts
import { createRedisStore } from '@clerk/mcp-tools/stores/redis';

const store = createRedisStore({
  url: process.env.REDIS_URL,
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
  filename: './mcp-sessions.db',
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
    interface CreateKnownCredentialsMcpClientParams {
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
    interface McpClientReturnType {
      /**
       * Represents a session associated with the connected MCP service endpoint.
       */
      sessionId: string;
      /**
       * Calling this function will initialize a connect to the MCP service.
       */
      connect: () => void;
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
    interface CreateDynamicallyRegisteredMcpClientParams {
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
    interface McpClientReturnType {
      /**
       * Represents a session associated with the connected MCP service endpoint.
       */
      sessionId: string;
      /**
       * Calling this function will initialize a connect to the MCP service.
       */
      connect: () => void;
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

- `getClientBySessionId`
  - **Description:** Given an existing session id, constructs a MCP client that matches the information used to create the client/session initially. Intended to be used in OAuth callback routes and any subsequent MCP calls once the service has been initialized.
  - **Arguments**:

  ```ts
  interface GetClientBySessionIdParams {
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
    interface McpClientReturnType {
      /**
       * Represents a session associated with the connected MCP service endpoint.
       */
      sessionId: string;
      /**
       * Calling this function will initialize a connect to the MCP service.
       */
      connect: () => void;
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

- `completeAuthWithCode`
  - **Description:** Designed to be used in the OAuth callback route. Passing in the code, state, and your store will finish the auth process
  - **Arguments:**

    ```ts
    interface CompleteAuthWithCodeParams {
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
    interface CompleteAuthWithCodeReturnType {
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
  - **Description:** Generates OAuth 2.0 Protected Resource Metadata as defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728). This metadata helps OAuth clients understand how to authenticate with your resource server.
  - **Arguments:**

    ```ts
    interface GenerateProtectedResourceMetadataParams {
      /**
       * URL of the OAuth authorization server
       */
      authServerUrl: string;
      /**
       * URL of the resource server that the metadata applies to
       */
      resourceUrl: string;
      /**
       * Additional properties to include in the metadata
       */
      properties?: Record<string, any>;
    }
    ```

  - **Return Type:**

    ```ts
    {
      resource: string;
      authorization_servers: string[];
      token_types_supported: string[];
      token_introspection_endpoint: string;
      token_introspection_endpoint_auth_methods_supported: string[];
      jwks_uri: string;
      authorization_data_types_supported: string[];
      authorization_data_locations_supported: string[];
      key_challenges_supported: Array<{
        challenge_type: string;
        challenge_algs: string[];
      }>;
      [key: string]: any; // Additional properties if provided
    }
    ```

- `generateClerkProtectedResourceMetadata`
  - **Description:** Generates OAuth 2.0 Protected Resource Metadata specifically configured for Clerk authentication. This is a convenience wrapper around `generateProtectedResourceMetadata` that automatically derives the auth server URL from your Clerk publishable key.
  - **Arguments:**

    ```ts
    interface GenerateClerkProtectedResourceMetadataParams {
      /**
       * Your Clerk publishable key (e.g., pk_test_... or pk_live_...)
       */
      publishableKey: string;
      /**
       * URL of the resource server that the metadata applies to
       */
      resourceUrl: string;
    }
    ```

  - **Return Type:** Same as `generateProtectedResourceMetadata`

- `fetchClerkAuthorizationServerMetadata`
  - **Description:** Fetches OAuth 2.0 Authorization Server Metadata from Clerk's servers based on your publishable key. This returns the actual metadata from Clerk's authorization server rather than generating it locally.
  - **Arguments:**

    ```ts
    interface FetchClerkAuthorizationServerMetadataParams {
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
  - **Description:** Returns `true` when an `AuthInfo` object came from `verifyClerkToken`, which marks its result with `extra.verifiedBy: 'clerk'` and a non-empty `extra.userId`. Use it to tell Clerk user and client ids apart from ones produced by a custom verifier. It is a type guard: after the check, TypeScript knows `authInfo.extra.userId` is a string.
  - **Params:** `authInfo: AuthInfo | undefined`
  - **Returns:** `authInfo is ClerkAuthInfo` (`ClerkAuthInfo` is also exported)

- `scopeChallengeFor`
  - **Description:** Builds the `scopeChallenge` registration option of MCP SDK 2.1 or later for a tool that needs `requiredScopes`. Before the tool runs, the SDK answers a token that lacks some of them with a `403` step-up challenge for the granted scopes followed by the missing ones. A request without auth info is left to the tool. Earlier SDK versions ignore the option. See [Step-up for your own tools](#step-up-for-your-own-tools).
  - **Params:** `requiredScopes: readonly string[]`
  - **Returns:** `ScopeChallengeHandler` (also exported), which is `(context: { authInfo?: AuthInfo }) => { scopes: readonly [string, ...string[]] } | undefined`

- `corsHeaders`
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

#### Framework-Specific Utilities

For framework-specific utilities and handlers, see:

- **Express.js**: See [Express.js reference documentation](./express/README.md)
- **Hono**: See [Hono reference documentation](./hono/README.md)
- **Next.js**: See [Next.js reference documentation](./next/README.md)
