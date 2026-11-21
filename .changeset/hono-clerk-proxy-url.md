---
'@clerk/mcp-tools': patch
---

The Hono adapter's `mcpAuth` now passes `CLERK_PROXY_URL` to the Clerk client it builds from the environment, when it is set, as `clerkClient` from `@clerk/express` does. Behind a proxy, Clerk issues OAuth access tokens with the proxy URL as their `iss`, and `@clerk/backend` will require `iss` to match the instance's Frontend API URL or its `proxyUrl`, so without it a proxied instance's tokens would be rejected. The Express and Next.js adapters' default clients already read `CLERK_PROXY_URL` and `NEXT_PUBLIC_CLERK_PROXY_URL`.
