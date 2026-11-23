// The official MCP Registry's two documents: the `server.json` a domain owner publishes with `mcp-publisher`, built
// from the Server Card options so the two can't drift, and the HTTP domain proof at `/.well-known/mcp-registry-auth`.
// `./server` re-exports the generator and the adapters mount the proof responder, so it must not import `./server`.
// This module is not a package entry point.
import {
  type Fail,
  assertKnownKeys,
  deepFreeze,
  failFor,
  isPlainObject,
} from './discovery-options';
import type { DiscoveryAnswer, DiscoveryRequest } from './discovery-response';
import { type McpResourceUrl, assertResourceUrls } from './resource-url';
import {
  type ServerCard,
  type ServerCardIcon,
  type ServerCardOptions,
  type ServerCardRepository,
  buildServerCard,
} from './server-card';

/**
 * The `$schema` every generated `server.json` carries: the registry's 2025-12-11 server schema.
 */
const REGISTRY_SERVER_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

/**
 * Input to `generateRegistryServerJson`: the options `serverCardHandler` takes, without `maxAge`, so one object
 * describes both. `name` is the registry name too, in the reverse-DNS namespace you prove you own, such as
 * `com.example/weather` for `example.com`. Each `resourceUrl` becomes one streamable HTTP remote. `_meta` is not
 * copied: the registry keeps only its own `io.modelcontextprotocol.registry/publisher-provided` key, which a card's
 * `_meta` can't use.
 */
export type RegistryServerJsonOptions = Omit<ServerCardOptions, 'resourceUrl'> & {
  /**
   * The exact https URL of the MCP endpoint, or a list of them, one for each origin, each listed as a remote
   */
  resourceUrl: McpResourceUrl;
};

/**
 * A `server.json` for the official MCP Registry, as `generateRegistryServerJson` generates it. It is frozen, all the
 * way down.
 */
export type RegistryServerJson = {
  readonly $schema: typeof REGISTRY_SERVER_SCHEMA;
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description: string;
  readonly websiteUrl?: string;
  readonly repository?: Readonly<ServerCardRepository>;
  readonly icons?: readonly Readonly<ServerCardIcon>[];
  readonly remotes: readonly { readonly type: 'streamable-http'; readonly url: string }[];
};

/**
 * Generates the `server.json` that `mcp-publisher publish` sends to the official MCP Registry, from the same options
 * as the server's Server Card, so the registry entry and the card describe one server. It checks the card's rules and
 * the registry's own: https icons, website, and remotes, icon media types the registry lists, a GitHub or GitLab
 * repository, and a version that is neither `latest` nor what the registry reads as a range, such as `1.0.0-next`. It makes no request; publishing stays a step you
 * run yourself.
 * @see https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
 * @param options - See `RegistryServerJsonOptions`
 * @returns The `server.json`, frozen, serializable to JSON. It throws a `Clerk error:` naming the first option the
 * registry would reject.
 * @example
 * ```ts
 * const serverJson = generateRegistryServerJson({
 *   name: 'com.example/weather',
 *   version: '1.2.0',
 *   description: 'Forecasts and current conditions.',
 *   resourceUrl: 'https://mcp.example.com/mcp',
 * });
 * ```
 */
export function generateRegistryServerJson(options: RegistryServerJsonOptions): RegistryServerJson {
  const caller = 'generateRegistryServerJson';
  const fail = failFor(caller);
  if (!isPlainObject(options)) {
    return fail(
      "takes the Server Card options, as generateRegistryServerJson({ name: 'com.example/weather', version: '1.0.0', description: 'Forecasts.', resourceUrl: 'https://mcp.example.com/mcp' })",
    );
  }
  const { resourceUrl, ...card } = options;
  assertResourceUrls(caller, resourceUrl);
  // A card for each URL checks the options as serverCardHandler does, so whatever the card takes the entry takes too
  const cards = [resourceUrl]
    .flat()
    .map((url) => buildServerCard(caller, { ...card, resourceUrl: url }));
  const [first] = cards as [ServerCard, ...ServerCard[]];
  assertRegistryRules(fail, first, cards);

  return deepFreeze(
    JSON.parse(
      JSON.stringify({
        $schema: REGISTRY_SERVER_SCHEMA,
        name: first.name,
        version: first.version,
        title: first.title,
        description: first.description,
        websiteUrl: first.websiteUrl,
        repository: first.repository,
        icons: first.icons,
        remotes: cards.map((each) => each.remotes[0]),
      }),
    ),
  );
}

// The registry's range check, looksLikeVersionRange in internal/validators/validators.go, which is broader than the
// card's: a dotted version with any x, X, or * in it, its prerelease included, reads as a wildcard range
const NUMBER = String.raw`v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?`;
const COMPARATOR_RANGE = new RegExp(String.raw`^\s*(?:\^|~|>=|<=|>|<|=)\s*${NUMBER}\s*$`);
const HYPHEN_RANGE = new RegExp(String.raw`^\s*${NUMBER}\s-\s*${NUMBER}\s*$`);
const OR_RANGE = new RegExp(String.raw`^\s*(?:${NUMBER}\s*)(?:\|\|\s*${NUMBER}\s*)+$`);
const DOTTED_VERSION_LIKE = /^\s*(?:v?\d+|x|X|\*)(?:\.(?:\d+|x|X|\*)){1,2}(?:-[0-9A-Za-z.-]+)?\s*$/;

function looksLikeVersionRange(version: string): boolean {
  const trimmed = version.trim();
  if (trimmed === '') return false;
  if (COMPARATOR_RANGE.test(trimmed) || HYPHEN_RANGE.test(trimmed) || OR_RANGE.test(trimmed)) {
    return true;
  }
  return DOTTED_VERSION_LIKE.test(trimmed) && /[xX*]/.test(trimmed);
}

// The registry schema's icon media types and sizes (definitions.Icon)
const ICON_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/svg+xml',
  'image/webp',
]);
const ICON_SIZE = /^(\d+x\d+|any)$/;
// The registry's repository URL rules for its two supported sources (internal/validators/utils.go)
const REPOSITORY_URL: Record<string, RegExp> = {
  github: /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?$/,
  gitlab: /^https?:\/\/(www\.)?gitlab\.com\/[\w.-]+(\/[\w.-]+)+\/?$/,
};

const isHttps = (url: string) => new URL(url).protocol === 'https:';

/**
 * The registry's checks beyond the card's: the 2025-12-11 schema's icon limits, and what its publish validation
 * rejects (internal/validators/validators.go).
 */
function assertRegistryRules(fail: Fail, card: ServerCard, cards: readonly ServerCard[]) {
  if (card.version === 'latest') fail("version cannot be 'latest', which the registry reserves");
  if (looksLikeVersionRange(card.version)) {
    fail(
      "version must be one the registry does not read as a range: it rejects a dotted version with an x, X, or * anywhere, such as '1.0.0-next', so use a prerelease such as '1.0.0-beta.1'",
    );
  }
  if (card.title !== undefined && card.title.trim() === '') {
    fail('title cannot be only whitespace');
  }
  if (
    card.websiteUrl !== undefined &&
    (!isHttps(card.websiteUrl) || card.websiteUrl.includes("'"))
  ) {
    fail("websiteUrl must be an https URL without ' characters: the registry rejects http");
  }
  for (const icon of card.icons ?? []) {
    if (!/^https:/i.test(icon.src) || !isHttps(icon.src) || [...icon.src].length > 255) {
      fail(
        'icons must each have an https src of at most 255 characters: the registry takes no http or data: icons',
      );
    }
    if (icon.mimeType !== undefined && !ICON_MIME_TYPES.has(icon.mimeType)) {
      fail(
        'icons mimeType must be image/png, image/jpeg, image/jpg, image/svg+xml, or image/webp, the types the registry takes',
      );
    }
    if (icon.sizes !== undefined && !icon.sizes.every((size) => ICON_SIZE.test(size))) {
      fail("icons sizes must each be WxH, such as '48x48', or 'any'");
    }
  }
  const { repository } = card;
  if (repository !== undefined) {
    const pattern = REPOSITORY_URL[repository.source];
    if (
      !pattern?.test(repository.url) ||
      (repository.source === 'gitlab' && `${repository.url}/`.includes('/-/'))
    ) {
      fail(
        "repository must be on GitHub or GitLab, the sources the registry takes: source 'github' with a url such as https://github.com/owner/repo, or source 'gitlab' with a url such as https://gitlab.com/group/project",
      );
    }
    if (repository.subfolder !== undefined && !/^[a-zA-Z0-9\-_./]+$/.test(repository.subfolder)) {
      fail('repository subfolder may hold only letters, digits, -, _, ., and /');
    }
  }
  for (const { remotes } of cards) {
    const { hostname } = new URL(remotes[0].url);
    if (
      !isHttps(remotes[0].url) ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.localhost')
    ) {
      fail(
        'resourceUrl must be https and not on localhost: the registry lists only public remotes',
      );
    }
  }
}

/**
 * Options for an `mcpRegistryAuthHandler`: the public key of the key pair `mcp-publisher login http` signs with.
 */
export type McpRegistryAuthHandlerOptions = {
  /**
   * The raw 32-byte Ed25519 public key in standard, padded base64: 43 characters and one `=`, as
   * `openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64` prints. Only the public key belongs here.
   */
  publicKey: string;
};

// The registry decodes `p` as standard, padded base64 and needs the raw 32-byte key, whose only such encoding is 43
// characters and one `=`. An SPKI DER export, URL-safe, or unpadded base64 fails login.
const ED25519_PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
const REGISTRY_AUTH_ALLOW = 'GET, HEAD';
const registryAuthKeys = new Set(['publicKey']);

/**
 * Validates an `mcpRegistryAuthHandler`'s options and returns the answers for its route: the MCPv1 proof record as
 * `text/plain` to GET and HEAD, never a redirect, which the registry does not follow, and a 405 to anything else. It
 * is never stored, so a retired key stops being served as soon as it is removed.
 * @param caller - The entry point named in error messages
 * @param options - The handler's options, unchecked
 * @returns The function that answers each request
 */
export function mcpRegistryAuthResponder(
  caller: string,
  options: unknown,
): (request: DiscoveryRequest) => DiscoveryAnswer {
  const fail = failFor(caller);
  if (!isPlainObject(options)) {
    return fail(
      `takes an options object with publicKey, as ${caller}({ publicKey: process.env.MCP_REGISTRY_PUBLIC_KEY })`,
    );
  }
  assertKnownKeys(fail, options, {
    allowed: registryAuthKeys,
    generated: new Set(),
    generatedMessage: () => '',
    unknownMessage: (key) => `does not take ${key}. It takes only publicKey`,
  });
  const { publicKey } = options;
  if (typeof publicKey !== 'string' || !ED25519_PUBLIC_KEY.test(publicKey)) {
    fail(
      'publicKey must be a raw 32-byte Ed25519 public key in standard base64, 43 characters and one =, as `openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64` prints. An SPKI DER export, URL-safe, or unpadded base64 is rejected by the registry',
    );
  }
  const body = `v=MCPv1; k=ed25519; p=${publicKey as string}`;
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    // A cache would keep serving a key after it is removed, which the registry would still accept
    'Cache-Control': 'no-store',
  };
  const contentLength = String(new TextEncoder().encode(body).byteLength);

  return ({ method }): DiscoveryAnswer => {
    if (method === 'GET') return { status: 200, headers, body };
    // RFC 9110 section 9.3.2: HEAD gets the GET's headers, including its Content-Length, without the content
    if (method === 'HEAD') {
      return { status: 200, headers: { ...headers, 'Content-Length': contentLength }, body: null };
    }
    return {
      status: 405,
      headers: {
        Allow: REGISTRY_AUTH_ALLOW,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ error: 'method_not_allowed' }),
    };
  };
}
