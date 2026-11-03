// Internal Clerk Backend API client shared by the tools. Not part of the package exports.
const DEFAULT_API_URL = 'https://api.clerk.com';

// Well under MCP clients' own request timeouts, so a stalled API still gets the agent a useful message.
const REQUEST_TIMEOUT_MS = 10_000;

export type BackendApiOptions = {
  /** Secret key of the Clerk instance. */
  secretKey: string;
  /** Origin of the Clerk Backend API. Defaults to https://api.clerk.com. */
  apiUrl?: string;
  /** Used for requests to the Clerk Backend API. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

export type BackendApiClient = {
  /** POSTs `body` as JSON with the secret key. */
  post(path: string, body: unknown): Promise<Response>;
};

/** Parses `value` as a URL that uses HTTPS, or HTTP on a loopback host. Returns `undefined` otherwise. */
export function parseAllowedUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const allowed =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    return allowed ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Throws a `Clerk error:` message, prefixed with `label`, when the secret key is blank. */
export function requireSecretKey(label: string, { secretKey }: BackendApiOptions): void {
  if (!secretKey?.trim()) {
    throw new Error(`Clerk error: ${label} requires the secretKey of a Clerk instance`);
  }
}

/**
 * Builds a client for `options`. Throws a `Clerk error:` message, prefixed with `label`, when the API URL is
 * neither HTTPS nor loopback HTTP, so the secret key is never sent anywhere else.
 */
export function createBackendApiClient(
  label: string,
  { secretKey, apiUrl = DEFAULT_API_URL, fetch: fetchImpl }: BackendApiOptions,
): BackendApiClient {
  const origin = parseAllowedUrl(apiUrl);
  if (!origin) {
    throw new Error(`Clerk error: ${label} apiUrl must use HTTPS or loopback HTTP`);
  }
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new Error(`Clerk error: ${label} fetch must be a function`);
  }
  return {
    post: (path, body) =>
      (fetchImpl ?? fetch)(new URL(path, origin), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
  };
}
