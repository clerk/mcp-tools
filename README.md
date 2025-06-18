# MCP Tools

A library built on top of the [MCP Typescript SDK](https://github.com/modelcontextprotocol/typescript-sdk) that makes it easier to implement MCP with auth into your MCP client and/or server.

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
import { generateProtectedResourceMetadata } from '@clerk/mcp-tools/server'

const result = generateProtectedResourceMetadata({
  resourceUrl: 'https://myapp.com/current-route',
  authServerUrl: 'https://auth.example.com'
});
```

You will want to set up a route at `.well-known/oauth-protected-resource` and make sure to return this result from that route on your server.

If you are using [Clerk](https://clerk.com) for authentication in your app, we have a helper that makes this easier:

```ts
import { generateClerkProtectedResourceMetadata } from "@clerk/mcp-tools/server";

const result = generateClerkProtectedResourceMetadata({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  resourceUrl: "https://myapp.com/current-route",
});
```

For framework-specific implementations of protected resource metadata handlers, see:
- [Express.js implementation](./express/README.md#protected-resource-metadata)
- [Next.js implementation](./next/README.md#protected-resource-metadata-handlers)

#### Authorization server metadata

> **NOTE:** This is not yet fully implemented

There is [an older version of the MCP spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization#2-5-authorization-flow-steps) that specified that the MCP server should be responsible for authentication on its own and instead it should implement a different static metadata file called "authorization server metadata", defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414). While it should not be necessary as long as you have implemented protected resource metadata and are using an authorization service that has properly implemented a authorization server metadata route, there are some scenarios where this might be necessary if you are building your own authorization server, if your authorization server is part of your app directly, or if you are interfacing with a client that has an outdated implementation. This library also provides utilities for this use case.

```ts
// return this result from <your-app>/.well-known/oauth-authorization-server
import { generateAuthorizationServerMetadata } from "@clerk/mcp-tools/server";

const result = generateAuthorizationServerMetadata({
  authServerUrl: "https://auth.example.com",
  scopes: ["email", "profile", "openid"],
});
```

In the most standard case, the above example will work, but it does make some assumptions about the authorization server, namely that:

- The authorization endpoint is: `<authServerUrl>/authorize`
- The registration endpoint is: `<authServerUrl>/register`
- The token endpoint is: `<authServerUrl>/token`
- The userInfo endpoint is: `<authServerUrl>/userinfo`
- The jwks endpoint is: `<authServerUrl>/.well-known/jwks.json`

If this isn't the case, you can pass in overrides for any of these values. Passing in false will omit the value, which can be useful in some cases, like if your authorization server does not support dynamic client registration:

```ts
// return this result from <your-app>/.well-known/oauth-authorization-server
import { generateAuthorizationServerMetadata } from "@clerk/mcp-tools/server";

const result = generateAuthorizationServerMetadata({
  authServerUrl: "https://auth.example.com",
  authorizationEndpoint: "foo/bar/authorize",
  registrationEndpoint: false,
  tokenEndpoint: "tokens",
  scopes: ["email", "profile", "openid", "foobar"],
});
```

If you are using [Clerk](https://clerk.com) for authentication in your app, you can use the following helper to fetch Clerk's metadata from your Clerk frontend API and return it.

```ts
import { generateClerkAuthorizationServerMetadata } from "@clerk/mcp-tools/server";

const result = generateClerkAuthorizationServerMetadata();
```

For framework-specific implementations, see:
- [Express.js implementation](./express/README.md)
- [Next.js implementation](./next/README.md#server-components)

#### Creating an MCP endpoint

To create an MCP endpoint that handles the actual MCP protocol communication, you'll need to use framework-specific adapters:

- **Express.js**: Use the `streamableHttpHandler` from `@clerk/mcp-tools/express` - see [Express.js guide](./express/README.md#mcp-request-handler)
- **Next.js**: Use the Next.js route handlers - see [Next.js guide](./next/README.md#server-components)

These adapters handle the MCP protocol details and integrate with your authentication system.

### Guide: building a client

The first step to building MCP compatibility into your AI application is allowing your users to connect with an MCP service. This can be kicked off simply with the URL of an MCP-compatible server, like `https://example.com/mcp`. Normally, your app would implement a text field where the user can enter an MCP endpoint, or have a pre-built integration where clicking a button would trigger an MCP connection flow with a baked-in endpoint URL.

The process of actually making the MCP connection using the SDK, however, is fairly arduous, so we expose some tools that can help make this easier.

#### Framework-agnostic client creation

Here's how you can create an MCP client using the core utilities:

```ts
import { createDynamicallyRegisteredMcpClient } from "@clerk/mcp-tools/client";
import { createRedisStore } from "@clerk/mcp-tools/stores/redis";

// Create a persistent store (use appropriate store for your environment)
const store = createRedisStore({ url: process.env.REDIS_URL });

export async function initializeMCPConnection(mcpEndpoint: string) {
  const { connect, sessionId } = createDynamicallyRegisteredMcpClient({
    mcpEndpoint,
    oauthScopes: "openid profile email",
    oauthRedirectUrl: "https://yourapp.com/oauth_callback",
    oauthClientUri: "https://yourapp.com",
    mcpClientName: "My App MCP Client",
    mcpClientVersion: "0.0.1",
    redirect: (url: string) => {
      // Implement redirect logic for your framework
      window.location.href = url;
    },
    store
  });

  // Connect to the MCP endpoint
  await connect();

  return { sessionId };
}
```

#### OAuth callback handling

After the user completes the OAuth flow, you'll need to handle the callback:

```ts
import { completeAuthWithCode } from "@clerk/mcp-tools/client";

export async function handleOAuthCallback(code: string, state: string) {
  const result = await completeAuthWithCode({ 
    state, 
    code, 
    store 
  });

  // OAuth flow is now complete
  return result;
}
```

#### Making MCP tool calls

Once authentication is complete, you can call MCP tools:

```ts
import { getClientBySessionId } from "@clerk/mcp-tools/client";

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
import fsStore from "@clerk/mcp-tools/stores/fs";
```

This uses a temporary file and is fast, easy, and adequate for local development and testing. However, it's not suitable for production since the file could be deleted at any time.

#### Production Stores

For production environments, use one of these persistent stores:

##### Redis Store

```ts
import { createRedisStore } from '@clerk/mcp-tools/stores/redis';

const store = createRedisStore({ 
  url: process.env.REDIS_URL 
});
```

##### Postgres Store

```ts
import { createPostgresStore } from '@clerk/mcp-tools/stores/postgres';

const store = createPostgresStore({ 
  connectionString: process.env.DATABASE_URL 
});
```

##### SQLite Store

```ts
import { createSqliteStore } from '@clerk/mcp-tools/stores/sqlite';

const store = createSqliteStore({ 
  filename: './mcp-sessions.db' 
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

- `generateProtectedResourceMetadata` - Generates OAuth 2.0 Protected Resource Metadata as defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)
- `generateClerkProtectedResourceMetadata` - Generates protected resource metadata specifically for Clerk authentication
- `generateAuthorizationServerMetadata` - Generates OAuth 2.0 Authorization Server Metadata as defined by [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)
- `generateClerkAuthorizationServerMetadata` - Generates authorization server metadata specifically for Clerk

For detailed documentation on server utilities, see the framework-specific guides:
- [Express.js server guide](./express/README.md)
- [Next.js server guide](./next/README.md#server-components)

#### Framework-Specific Utilities

For framework-specific utilities and handlers, see:
- **Express.js**: See [Express.js reference documentation](./express/README.md)
- **Next.js**: See [Next.js reference documentation](./next/README.md)
