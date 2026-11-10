import type { Request as ExpressRequest } from 'express';
import type { Context } from 'hono';
import { describe, test } from 'vitest';

import { type McpAuthOptions as ExpressMcpAuthOptions, mcpAuth as expressMcpAuth } from './express';
import { type McpAuthOptions as HonoMcpAuthOptions, mcpAuth as honoMcpAuth } from './hono';
import { type McpAuthOptions as NextMcpAuthOptions, withMcpAuth as nextWithMcpAuth } from './next';
import type { ClerkOAuthClient } from './server';

describe('the mcpAuth options', () => {
  const resourceUrl = 'https://mcp.example.com/mcp';
  const clerkClient = {} as ClerkOAuthClient;
  const verifyToken = async () => undefined;
  const handler = () => new Response();

  test('accept Clerk verification with a resourceUrl, with or without a clerkClient', () => {
    expressMcpAuth({ resourceUrl });
    expressMcpAuth({ resourceUrl, clerkClient, requiredScopes: ['profile'] });
    honoMcpAuth({ resourceUrl });
    honoMcpAuth({ resourceUrl, clerkClient, challengeScopes: ['email'] });
    nextWithMcpAuth(handler, { resourceUrl, clerkClient, requiredScopes: ['profile'] });
  });

  test('accept a verifyToken with or without a resourceUrl', () => {
    expressMcpAuth({ verifyToken });
    expressMcpAuth({ verifyToken, resourceUrl, requiredScopes: ['profile'] });
    honoMcpAuth({ verifyToken });
    honoMcpAuth({ verifyToken, resourceUrl, requiredScopes: ['profile'] });
    nextWithMcpAuth(handler, { verifyToken });
    nextWithMcpAuth(handler, { verifyToken, resourceUrl, requiredScopes: ['profile'] });
  });

  test("pass verifyToken the framework's request", () => {
    expressMcpAuth({ verifyToken: async (_token: string, _req: ExpressRequest) => undefined });
    honoMcpAuth({ verifyToken: async (_token: string, _c: Context) => undefined });
    nextWithMcpAuth(handler, { verifyToken: async (_token: string, _req: Request) => undefined });
  });

  test('accept a verifyToken that returns without a promise', () => {
    const authInfo = { token: 'token', clientId: 'client', scopes: [] };
    expressMcpAuth({ verifyToken: (token) => (token ? authInfo : undefined) });
    honoMcpAuth({ verifyToken: (token) => (token ? authInfo : undefined) });
    nextWithMcpAuth(handler, { verifyToken: (token) => (token ? authInfo : undefined) });
  });

  test('accept onAuthFailure in Next.js with either verifier', () => {
    const onAuthFailure = () => {};
    nextWithMcpAuth(handler, { resourceUrl, clerkClient, onAuthFailure });
    nextWithMcpAuth(handler, { verifyToken, onAuthFailure });
  });

  test('require a resourceUrl without verifyToken', () => {
    // @ts-expect-error no resourceUrl or verifyToken
    expressMcpAuth({});
    // @ts-expect-error no resourceUrl or verifyToken
    expressMcpAuth({ clerkClient });
    // @ts-expect-error no resourceUrl or verifyToken
    honoMcpAuth({ requiredScopes: ['profile'] });
    // @ts-expect-error no resourceUrl or verifyToken
    honoMcpAuth({ clerkClient });
    // @ts-expect-error no resourceUrl or verifyToken
    nextWithMcpAuth(handler, { clerkClient });
  });

  test('require a clerkClient in Next.js without verifyToken', () => {
    // @ts-expect-error no clerkClient or verifyToken
    nextWithMcpAuth(handler, { resourceUrl });
  });

  test('reject clerkClient together with verifyToken', () => {
    // @ts-expect-error two verifiers
    expressMcpAuth({ verifyToken, clerkClient, resourceUrl });
    // @ts-expect-error two verifiers
    honoMcpAuth({ verifyToken, clerkClient, resourceUrl });
    // @ts-expect-error two verifiers
    nextWithMcpAuth(handler, { verifyToken, clerkClient, resourceUrl });
  });

  test('reject a verifier function in place of the options', () => {
    // @ts-expect-error the positional form was removed
    expressMcpAuth(verifyToken);
    // @ts-expect-error the positional form was removed
    honoMcpAuth(verifyToken, { resourceUrl });
    // @ts-expect-error mcp-handler's call form
    nextWithMcpAuth(handler, verifyToken);
  });

  test('name one options type per adapter', () => {
    const express: ExpressMcpAuthOptions = { resourceUrl };
    const hono: HonoMcpAuthOptions = { verifyToken };
    const next: NextMcpAuthOptions = { verifyToken };
    expressMcpAuth(express);
    honoMcpAuth(hono);
    nextWithMcpAuth(handler, next);
  });
});
