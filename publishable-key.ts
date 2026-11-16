// The publishable key decoding that `server.ts` and the metadata handlers share. This module is not a package entry
// point.

// A publishable key is `pk_test_` or `pk_live_` and the base64 of the Frontend API host followed by `$`
export function deriveFapiUrl(publishableKey: string) {
  const key = /^pk_(?:test|live)_([A-Za-z0-9+/_=-]+)$/.exec(publishableKey)?.[1] ?? '';
  const normalizedKey = key.replace(/-/g, '+').replace(/_/g, '/');
  const paddedKey = normalizedKey.padEnd(Math.ceil(normalizedKey.length / 4) * 4, '=');
  let decoded = '';
  try {
    decoded = atob(paddedKey);
  } catch {}
  if (!decoded.endsWith('$') || decoded.length === 1) {
    throw new Error(
      'Clerk error: the publishable key is not a Clerk publishable key. Copy it from the API keys page of the Clerk Dashboard',
    );
  }
  return `https://${decoded.slice(0, -1)}`;
}
