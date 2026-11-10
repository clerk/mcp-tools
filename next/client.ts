// MCP client helpers for Next.js. Kept out of `@clerk/mcp-tools/next` because they load `@modelcontextprotocol/sdk`,
// which servers on MCP SDK 2.x (`@modelcontextprotocol/server`, as `mcp-handler` 2.x uses) do not install.
import type { NextRequest } from 'next/server';
import { type McpClientStore, completeOAuth } from '../client';

/**
 * A request handler intended to be run at the OAuth callback endpoint.
 * It will complete the OAuth flow by exchanging the authorization code for a
 * token, store the token, then call the passed in callback fn when complete.
 * @param store - The client store to use for storing the token.
 * @param callback - A function to call once the OAuth flow is complete.
 */
export function completeOAuthHandler({
  store,
  callback,
}: {
  store: McpClientStore;
  callback: (params: Awaited<ReturnType<typeof completeOAuth>>) => void;
}): (req: NextRequest) => Promise<Response | ReturnType<typeof callback>> {
  return async (req: NextRequest): Promise<Response | ReturnType<typeof callback>> => {
    const qs = req.nextUrl.searchParams;
    const code = qs.get('code');
    const state = qs.get('state');

    if (!state) {
      return Response.json({ error: 'State missing' }, { status: 400 });
    }

    if (!code) {
      return Response.json({ error: 'Authorization code missing' }, { status: 400 });
    }

    // this function will run the state param check internally
    const res = await completeOAuth({ state, code, store });

    return callback(res);
  };
}
