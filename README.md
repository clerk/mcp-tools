# MCP Tools

A libary built on top of the [MCP Typescript SDK](https://github.com/modelcontextprotocol/typescript-sdk) that makes it easier to implement MCP with auth into your MCP client and/or server.

### What is MCP?

It's a protocol that enables AI applications like Claude, ChatGPT, Cursor, etc to ask you for permission to access some of your private information that normally you'd need to sign in with your account to access. For example, your emails, or your private github repositories, etc.

This allows you to provide AI applications with context and abilities that it would normally not have access to. You could, for example, have an AI application use some code in a private repo as context to answer your questions, or have it send write and an email on your behalf, after you review it. It's kind of like this:

![A diagram of how MCP works in 3 steps: 1) AI app asks for permission to connect to gmail, 2) user grants permission, 3) AI app can now access gmail data](https://p176.p0.n0.cdn.zight.com/items/p9uyYBQL/5743e744-1c37-462c-92a6-2cf30c40d6be.png?v=eeadf50900b2781e996c0f4752dd8949)

We think this is really cool because it enables people to use AI to access a bunch of extra information that it wasn't able to access before, and does so in a safe way where you as the user are in control over what it has access to and what it can do. We are excited to see how many new use cases as possibilities open up for AI use as MCP becomes more popular, and we built this library to try to help make it easier for people to integrate MCP into their applications.

### Client vs Server usage

There are two parties involved in MCP:

- The **client**, which is the one that wants to get access to another sevice. In the above example would be Claude, which wants to get access to Gmail.
- The **server**, which is the one that has something that a client wants access to. In the above example, this would be Gmail. This is sometimes referred to as the "resource server" or "MCP server".

This library has tools for both of these parties, so step one is to be clear on whether you are building a client or server. We'll address each of these use cases separately.

> _**NOTE:** In web development, the terms "client" and "server" are often used to refer to the frontend (browser) and backend (web server). This is not the case in this situation, so try not to confuse them!_

### Table of Contents

- [Guide: building a server](https://github.com/clerk/mcp-tools?tab=readme-ov-file#guide-building-a-server)
- [Guide: building a client](https://github.com/clerk/mcp-tools?tab=readme-ov-file#guide-building-a-client)
- [Reference docs](https://github.com/clerk/mcp-tools?tab=readme-ov-file#reference-docs)

### Guide: building a server

If you are building a server that you'd like to introduce MCP support for, you will want to use the `@clerk/mcp-tools/server` import path.

#### Protected resource metadata

In order for the [most up to date authentication flow in the MCP spec](https://modelcontextprotocol.io/specification/draft/basic/authorization#2-6-authorization-flow-steps) to work correctly, your server will need to expose a static metadata file called "protected resource metadata", which is defined by [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).

This library exposes a tool that can quickly generate such a metadata file for you. Here's an example of how to use it:

```ts
import { generateProtectedResourceMetadata } from '@clerk/mcp-tools/server'

const result = generateProtectedResourceMetadata({
    authServerUrl: 'https://auth.example.com'
    resourceServerUrl: 'https://myapp.com'
});
```

You will want to set up a route at `.well-known/oauth-protected-resource` and make sure to return this result from that route on your server.

If you are using [Clerk](https://clerk.com) for authentication in your app, we have a helper that makes this easier:

```ts
import { generateClerkProtectedResourceMetadata } from "@clerk/mcp-tools/server";

const result = generateClerkProtectedResourceMetadata({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  resourceServerUrl: "https://myapp.com",
});
```

And finally, if you are using Next.js, we have a framework-specific utility that makes it easier still:

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandler } from "@clerk-mcp-tools/next/server";

const handler = protectedResourceHandler({
  authServerUrl: "https://auth.example.com",
});

export { handler as GET };
```

Or if you're using Next.js and Clerk:

```ts
// app/.well-known/oauth-protected-resource/route.ts
import { protectedResourceHandlerClerk } from "@clerk-mcp-tools/next/server";

const handler = protectedResourceHandlerClerk(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
);

export { handler as GET };
```

#### Authorization server metadata

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

As with protected resource metadata, if you are using [Clerk](https://clerk.com) for authentication in your app, we have a helper that makes this easier:

```ts
import { generateClerkAuthorizationServerMetadata } from "@clerk/mcp-tools/server";

const result = generateClerkAuthorizationServerMetadata({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});
```

And also as with protected resource metadata, if you are using Next.js, we have a framework-specific utility that makes it easier still:

```ts
// app/.well-known/oauth-authorization-server/route.ts
import { authServerMetadataHandler } from "@clerk-mcp-tools/next/server";

const handler = authServerMetadataHandler({
  authServerUrl: "https://auth.example.com",
});

export { handler as GET };
```

Or if you're using Next.js and Clerk:

```ts
// app/.well-known/oauth-authorization-server/route.ts
import { authServerMetadataHandlerClerk } from "@clerk-mcp-tools/next/server";

const handler = authServerMetadataHandlerClerk(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
);

export { handler as GET };
```

#### Creating an MCP endpoint

- If you're using nextjs, you can use vercel's adapter
- If not, we have an adapter for express
- Can we make a generalized one?!
- We'd be happy to build more adapters, they are dependent on the structure of the request object though
- I need to look into how the session id handling thing is working in my current code, it may well be broken
  - Their entire design assumed that you can hold on to the mcp client/transport in memory which is foolish

### Guide: building a client

The first step to building MCP compatibility into your AI application is allowing your users to connect with an MCP service. This can be kicked off simply with the URL of an MCP-compatible server, like `https://example.com/mcp`. Normally, your app would implement a text field where the user can enter an MCP endpoint, or have a pre-built integration where clicking a button would trigger an MCP connection flow with a baked-in endpoint URL.

The process of actually making the MCP connection using the SDK, however, is fairly arduous, so we expose some tools that can help make this easier. Here's how it might look if it was being implemented as a next.js server action:

> _**NOTE:** If you are not using nextjs, the code here should be similar and easily adaptable, you may just need to change how the data is received from the request, how cookies are set, and how the response is delivered._

```ts
// app/actions/mcp-register.ts
'use server';

import { createDynamicallyRegisteredMcpClient } from "@clerk/mcp-tools/client";
import fsStore from "@clerk/mcp-tools/stores/fs";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

export async function submitIntegration(formData: FormData) {
  const mcpEndpoint = formData.get("url")?.toString();

  if (!mcpEndpoint) return { error: "MCP server url not passed" };

  const { connect, sessionId } = createDynamicallyRegisteredMcpClient({
      mcpEndpoint,
      oauthScopes: "openid profile email",
      oauthRedirectUrl: "http://localhost:3000/oauth_callback",
      oauthClientUri: "http://example.com",
      mcpClientName: "My App MCP Client",
      mcpClientVersion: "0.0.1",
      redirect: (url: string) => redirect(url);
      store: fsStore
    });

  // connect to the mcp endpoint
  await connect();

  // set mcp session id in a cookie so we can use it in tool calls later
  cookies().set('mcp-session', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
  })

  return { success: true }
}
```

Running this code will kick off an OAuth flow in the user's browser where the user will need to accept the requested scopes, then when complete, will redirect back to the `oauthRedirectUrl`. Let's implement the oauth redirect url route now:

```ts
// app/oauth_callback/route.ts
import { completeOAuthHandler } from "@clerk/mcp-tools/next/client";
import fsStore from "@clerk/mcp-tools/stores/fs";

const handler = completeOAuthHandler({
  store: fsStore,
  callback: () => redirect("/"),
});

export { handler as GET };
```

This is extra simple, since we're using the nextjs-specific utility, and we know exactly what we expect to get back in the OAuth callback. Here's what it would look like were we to implement this using non-nextjs-specific utilities as well:

```ts
// app/oauth_callback/route.ts
import { completeAuthWithCode } from "@clerk/mcp-tools/client";
import fsStore from "@clerk/mcp-tools/stores/fs";
import { type NextRequest } from "next/server";
import { redirect } from "next/navigation";

export function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams;
  const code = qs.get("code");
  const state = qs.get("state");

  if (!state) {
    return Response.json({ error: "State missing" }, { status: 400 });
  }

  if (!code) {
    return Response.json(
      { error: "Authorization code missing" },
      { status: 400 }
    );
  }

  // this function will run the state param equality check for you
  // if anything doesn't line up, it will error
  const res = await completeAuthWithCode({ state, code, store });

  return redirect("/");
}
```

Still fairly simple, and again this pattern could easily be implemented in any other framework just by modifying the methods that get the querystring values and how the redirect happens.

With this done, the auth process is complete, and you have a `mcp-session` cookie which you can use send with any tool calls in order to authenticate them. Now let's look at how you'd make an MCP request, since auth is complete:

```ts
import { mcpClientHandler } from "@clerk/mcp-tools/next/client";
import fsStore from "@clerk/mcp-tools/stores/fs";

const handler = mcpClientHandler(async ({ client, request }) => {
  // this assumes the "sides" argument was submitted in a POST request, as an example
  // in reality this would likely be an entire message from a user and a LLM SDK would
  // parse the tool and arguments out of it
  const body = await request.json();

  const toolResponse = await client.callTool({
    name: "roll_dice",
    arguments: { sides: body.sides },
  });

  return Response.json(toolResponse);
});

export { handler as POST };
```

Again, this is the streamlined nextjs-specific function, but here's how it could be written with framework-agnostic tooling:

```ts
import { getClientBySessionId } from "@clerk/mcp-tools/next/client";
import { cookies } from 'next/headers'
import fsStore from "@clerk/mcp-tools/stores/fs";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const body = await request.json();

  const { connect } = getClientBySessionId({
    sessionId: cookieStore.get('mcp-session')
    store: fsStore,
  });

  await connect();

  const toolRes = await client.callTool({
    name: "roll_dice",
    arguments: { sides: body.sides },
  });

  return Response.json(toolRes);
}
```

That's all it takes to wire up a fully functional MCP integration with authentication, built on the most recent version of the MCP spec! Pretty cool.

#### Stores

You may have noticed references to a `fsStore` in the above examples. In order to implement MCP functionality in a client persistent storage is required. This is because:

- The MCP flow operates across a minumum of three distinct server endpoints (initialization of mcp client, oauth callback, mcp request), and these server endpoints could be deployed to distinct serverless/edge functions without a shared memory pool.
- Since the MCP connection is intended to be long-running, it must maintain a "session". Relying on in-memory storage for long-running sessions is generally a very bad idea ™️, since it would bloat memory requirements indefinitely as the app scales, and any sort of clearing of memory like a server restart would immediately invalidate all sessions.

As such, each of the client functions require that you pass in a store adapter. Examples show the `fsStore`, which uses a tempfile that it writes json to. This is fast, easy, and adequate for local development and testing. However, if you are moving to a production environment, relying on a tempfile is also a very bad idea ™️, since it could be deleted at any time, and much like a memory store, is guaranteed deleted on a system restart.

There are a couple additional adapters that are built in here that are more production ready:

- Redis store (`import { createRedisStore } from '@clerk/mcp-tools/stores/redis'`)
- Postgres store (`import { createPostgresStore } from '@clerk/mcp-tools/stores/postgres'`)
- Sqlite store (`import { createSqliteStore } from '@clerk/mcp-tools/stores/sqlite'`)

If you wish to use a different kind of store, you are welcome to implement one on your own, and it will work just fine so long as it complies with the following very simple spec:

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

The built in stores have a few extra methods built in that may be useful, but only read and write are required for this to work.

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

> The docs below are not yet complete, but are coming soon!

#### Scope: `@clerk/mcp-tools/server`

`generateProtectedResourceMetadata`

`generateProtectedResourceMetadataClerk`

`generateAuthServerMetadata`

`generateAuthServerMetadataClerk`

#### Scope: `@clerk/mcp-tools/next`

`completeOAuthHandler`

`protectedResourceMetadataHandler`

`protectedResourceMetadataHandlerClerk`

`authServerMetadataHandler`

`authServerMetadataHandlerClerk`

`mcpClientHandler`
