import type { Request as ExpressRequest } from 'express';
import type { Context } from 'hono';
import { describe, test } from 'vitest';

import {
  type McpAuthOptions as ExpressMcpAuthOptions,
  mcpAuth as expressMcpAuth,
  protectedResourceMetadataHandler as expressMetadataHandler,
} from './express';
import {
  type McpAuthOptions as HonoMcpAuthOptions,
  mcpAuth as honoMcpAuth,
  protectedResourceMetadataHandler as honoMetadataHandler,
} from './hono';
import {
  type McpAuthOptions as NextMcpAuthOptions,
  withMcpAuth as nextWithMcpAuth,
  protectedResourceMetadataHandler as nextMetadataHandler,
} from './next';
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

  test('are accepted by protectedResourceMetadataHandler as one shared object', () => {
    const expressOptions = {
      resourceUrl,
      clerkClient,
      requiredScopes: ['profile'],
      challengeScopes: ['email'],
    };
    expressMcpAuth(expressOptions);
    expressMetadataHandler(expressOptions);

    const expressVerifierOptions = {
      verifyToken: async (_token: string, _req: ExpressRequest) => undefined,
      resourceUrl,
    };
    expressMcpAuth(expressVerifierOptions);
    expressMetadataHandler(expressVerifierOptions);

    const honoOptions = { resourceUrl, requiredScopes: ['profile'] };
    honoMcpAuth(honoOptions);
    honoMetadataHandler(honoOptions);

    const honoVerifierOptions = { verifyToken: async (_token: string, _c: Context) => undefined };
    honoMcpAuth(honoVerifierOptions);
    honoMetadataHandler(honoVerifierOptions);

    const nextOptions = {
      resourceUrl,
      clerkClient,
      requiredScopes: ['profile'],
      onAuthFailure: () => {},
    } satisfies NextMcpAuthOptions;
    nextWithMcpAuth(handler, nextOptions);
    nextMetadataHandler(nextOptions);
  });

  // A literal written in the call gets the excess-property check a shared variable does not
  test("accept every key of the adapter's mcpAuth options in protectedResourceMetadataHandler", () => {
    expressMetadataHandler({ resourceUrl, clerkClient, requiredScopes: ['profile'] });
    expressMetadataHandler({
      verifyToken: async (_token: string, _req: ExpressRequest) => undefined,
    });
    honoMetadataHandler({ resourceUrl, clerkClient, challengeScopes: ['email'] });
    honoMetadataHandler({ verifyToken: async (_token: string, _c: Context) => undefined });
    nextMetadataHandler({ resourceUrl, clerkClient, requiredScopes: ['profile'] });
    nextMetadataHandler({ verifyToken, onAuthFailure: () => {} });
  });

  test('keep the metadata options free of keys mcpAuth does not take', () => {
    // @ts-expect-error the old form, additional metadata in place of options
    expressMetadataHandler({ scopes_supported: ['email'] });
    // @ts-expect-error a key neither call takes
    honoMetadataHandler({ resourceUrl, resource_name: 'MCP' });
    // @ts-expect-error a verifier for another framework's request
    nextMetadataHandler({ verifyToken: async (_token: string, _c: Context) => undefined });
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

describe('authorizationServerMetadataHandler', () => {
  type Factories = [
    (typeof import('./express'))['authorizationServerMetadataHandler'],
    (typeof import('./hono'))['authorizationServerMetadataHandler'],
    (typeof import('./next'))['authorizationServerMetadataHandler'],
  ];

  test('still takes no arguments in every adapter', () => {
    const takesNoArguments: Parameters<Factories[number]>['length'] = 0;
    // @ts-expect-error the factory takes no arguments
    const takesAnArgument: Parameters<Factories[number]>['length'] = 1;
    void takesNoArguments;
    void takesAnArgument;
  });
});
