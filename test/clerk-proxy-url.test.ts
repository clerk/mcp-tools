// Each adapter's default Clerk client, the real one from its SDK, verifies tokens with the instance's proxy URL. Behind
// a proxy, Clerk issues OAuth access tokens with the proxy URL as their `iss`, which `@clerk/backend` compares against
// the `proxyUrl` the client was created with. The clients are wrapped only to record the request state Clerk
// answered, which carries the `proxyUrl` the token was verified with.
import express from 'express';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Client = { authenticateRequest: (...args: never[]) => Promise<{ proxyUrl?: string }> };

// Hoisted with the mocks that use it
const { recorded, recording } = vi.hoisted(() => {
  // `@clerk/nextjs` reads its environment when the module loads, so the keys are set before any import
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
  process.env.NEXT_PUBLIC_CLERK_PROXY_URL = 'https://example.com/__clerk';
  const recorded = { states: [] as { proxyUrl?: string }[] };
  const isRecording = Symbol('recording');
  // `@clerk/nextjs` builds its client with `createClerkClient` from `@clerk/backend`, which is wrapped too, so a client
  // is wrapped only once
  function recording<T extends Client>(client: T): T {
    if (isRecording in client) return client;
    return {
      ...client,
      [isRecording]: true,
      authenticateRequest: async (...args: never[]) => {
        const state = await client.authenticateRequest(...args);
        recorded.states.push(state);
        return state;
      },
    };
  }
  return { recorded, recording };
});

vi.mock('@clerk/backend', async (importOriginal) => {
  const backend = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...backend,
    createClerkClient: (...args: Parameters<typeof backend.createClerkClient>) =>
      recording(backend.createClerkClient(...args)),
  };
});

vi.mock('@clerk/express', async (importOriginal) => {
  const clerkExpress = await importOriginal<typeof import('@clerk/express')>();
  return { ...clerkExpress, clerkClient: recording(clerkExpress.clerkClient) };
});

vi.mock('@clerk/nextjs/server', async (importOriginal) => {
  const nextjs = await importOriginal<typeof import('@clerk/nextjs/server')>();
  return { ...nextjs, clerkClient: async () => recording(await nextjs.clerkClient()) };
});

import * as expressAdapter from '../express';
import * as honoAdapter from '../hono';
import * as nextAdapter from '../next';
import { FAKE_PK, withListening } from './mcp-harness';

const resourceUrl = 'https://mcp.example.com/mcp';
const proxyUrl = 'https://example.com/__clerk';
const headers = { Authorization: 'Bearer not-a-clerk-token' };

const adapters = {
  express: async () => {
    const app = express();
    app.post('/mcp', expressAdapter.mcpAuth({ resourceUrl }), (_req, res) => {
      res.json({});
    });
    return withListening(app, (baseUrl) => fetch(`${baseUrl}/mcp`, { method: 'POST', headers }));
  },
  hono: async () => {
    const app = new Hono();
    app.post('/mcp', honoAdapter.mcpAuth({ resourceUrl }), (c) => c.json({}));
    return app.request(resourceUrl, { method: 'POST', headers });
  },
  next: async () => {
    const handler = nextAdapter.withClerkMcpAuth(() => Response.json({}), { resourceUrl });
    return handler(new Request(resourceUrl, { method: 'POST', headers }));
  },
};

describe.each(Object.keys(adapters) as (keyof typeof adapters)[])(
  "%s's default Clerk client",
  (adapter) => {
    beforeEach(() => {
      recorded.states.length = 0;
      vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_proxy');
      vi.stubEnv('CLERK_PUBLISHABLE_KEY', FAKE_PK);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test('verifies tokens with the proxy URL from the environment', async () => {
      vi.stubEnv('CLERK_PROXY_URL', proxyUrl);
      vi.stubEnv('NEXT_PUBLIC_CLERK_PROXY_URL', proxyUrl);

      expect((await adapters[adapter]()).status).toBe(401);

      expect(recorded.states).toEqual([expect.objectContaining({ proxyUrl })]);
    });
  },
);
