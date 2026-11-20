// Real tool calls through each adapter and its SDK transport, including both tools' Clerk identity guards.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import express from 'express';
import { Hono } from 'hono';
import { createMcpHandler } from 'mcp-handler';
import { describe, expect, test, vi } from 'vitest';

import * as expressAdapter from '../express';
import * as honoAdapter from '../hono';
import * as nextAdapter from '../next';
import type { AuthInfo } from '../mcp-types';
import { toolAuthInfo } from '../mcp-tool';
import { isClerkAuthInfo } from '../server';
import { createBrowserSessionTool, ERROR_CODE_META_KEY, submitFeedbackTool } from '../tools';
import { clerkAuthenticated, expiresAt, withListening } from './mcp-harness';

const origin = 'https://mcp.example.com';
const feedbackInput = {
  kind: 'broken',
  task: 'Create a user',
  description: 'The request failed.',
  impact: 'blocked',
};

describe.each(['express', 'hono', 'next'] as const)(
  '%s Clerk provenance through the SDK',
  (adapter) => {
    test.each([true, false])(
      'tools trust Clerk identity only when Clerk verified it: %s',
      async (verified) => {
        let adapterAuth: AuthInfo | undefined;
        const toolAuth: AuthInfo[] = [];
        const payloads: Record<string, unknown>[] = [];
        const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
          payloads.push(JSON.parse(String(init?.body)));
          return String(url).endsWith('/agents/tasks')
            ? Response.json({
                url: 'https://accounts.example.com/v1/tickets/accept?ticket=test',
                agent_task_id: 'agttsk_1',
                session_restricted: true,
              })
            : Response.json(
                { id: 'fbk_1', created_at: '2026-10-21T00:00:00.000Z' },
                { status: 201 },
              );
        });
        const fake = {
          token: 'token',
          clientId: 'client-1',
          scopes: [],
          expiresAt,
          extra: { userId: 'user-1', verifiedBy: 'clerk' },
        };
        const authOptions = (resourceUrl: string) =>
          verified
            ? {
                resourceUrl,
                clerkClient: {
                  authenticateRequest: vi.fn().mockResolvedValue(clerkAuthenticated()),
                },
              }
            : { resourceUrl, verifyToken: () => fake };

        // Wrap the real callbacks only to assert reference identity at the point their own guards read auth info.
        const browser = createBrowserSessionTool({
          secretKey: 'sk_test_provenance',
          destinationUrl: 'https://app.example.com/',
          requiredScopes: [],
          fetch: fetchImpl,
        });
        const browserCallback = browser[2];
        browser[2] = async (input, extra) => {
          const authInfo = toolAuthInfo(extra);
          expect(authInfo).toBe(adapterAuth);
          expect(isClerkAuthInfo(authInfo)).toBe(verified);
          toolAuth.push(authInfo!);
          return browserCallback(input, extra);
        };
        const feedback = submitFeedbackTool({ secretKey: 'sk_test_provenance', fetch: fetchImpl });
        const feedbackCallback = feedback[2];
        feedback[2] = async (input, extra) => {
          const authInfo = toolAuthInfo(extra);
          expect(authInfo).toBe(adapterAuth);
          expect(isClerkAuthInfo(authInfo)).toBe(verified);
          toolAuth.push(authInfo!);
          return feedbackCallback(input, extra);
        };
        const makeServer = () => {
          const server = new McpServer({ name: 'provenance', version: '0.0.0' });
          server.registerTool(...browser);
          server.registerTool(...feedback);
          return server;
        };
        const body = (name: string) => ({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: name === 'submit_feedback' ? feedbackInput : {} },
        });
        const headers = {
          authorization: 'Bearer token',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        };
        const run = async (request: (name: string) => Promise<Response>) => {
          const browserResponse = await request('create_browser_session');
          const browserText = await browserResponse.text();
          expect(browserResponse.status).toBe(200);
          if (verified) {
            expect(browserText).toContain('agttsk_1');
            expect(payloads[0]).toMatchObject({ on_behalf_of: { user_id: 'user-1' } });
          } else {
            expect(browserText).toContain(ERROR_CODE_META_KEY);
            expect(browserText).toContain('not_authenticated');
            expect(fetchImpl).not.toHaveBeenCalled();
          }
          const feedbackResponse = await request('submit_feedback');
          expect(feedbackResponse.status).toBe(200);
          expect(await feedbackResponse.text()).toContain('fbk_1');
          if (verified) {
            expect(payloads.at(-1)).toMatchObject({ user_id: 'user-1', client_id: 'client-1' });
          } else {
            expect(payloads.at(-1)).not.toHaveProperty('user_id');
            expect(payloads.at(-1)).not.toHaveProperty('client_id');
          }
          expect(toolAuth).toHaveLength(2);
        };

        if (adapter === 'express') {
          const app = express();
          app.use(express.json());
          await withListening(app, async (base) => {
            app.post(
              '/mcp',
              expressAdapter.mcpAuth(authOptions(`${base}/mcp`)),
              (req, _res, next) => {
                adapterAuth = (req as express.Request & { auth?: AuthInfo }).auth;
                next();
              },
              expressAdapter.streamableHttpHandler(makeServer, StreamableHTTPServerTransport),
            );
            await run((name) =>
              fetch(`${base}/mcp`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body(name)),
                signal: AbortSignal.timeout(5000),
              }),
            );
          });
          return;
        }
        const request = (name: string) =>
          new Request(`${origin}/mcp`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body(name)),
          });
        if (adapter === 'hono') {
          const app = new Hono();
          app.post(
            '/mcp',
            honoAdapter.mcpAuth(authOptions(`${origin}/mcp`)),
            async (c, next) => {
              adapterAuth = c.get('mcpAuth');
              await next();
            },
            honoAdapter.streamableHttpHandler(makeServer, WebStandardStreamableHTTPServerTransport),
          );
          await run(async (name) => app.request(request(name)));
          return;
        }
        // The actual Next.js handler uses SDK 2.x, which passes http.authInfo rather than SDK 1.x's extra.authInfo.
        const handler = createMcpHandler((server) => {
          server.registerTool(...browser);
          server.registerTool(...feedback);
        });
        const route = nextAdapter.withClerkMcpAuth(
          (req) => {
            adapterAuth = (req as Request & { auth?: AuthInfo }).auth;
            return handler(req);
          },
          authOptions(`${origin}/mcp`),
        );
        await run((name) => route(request(name)));
      },
    );
  },
);
