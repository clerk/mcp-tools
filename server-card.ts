// The Server Card builder: the supported subset of the MCP Server Card extension, pinned at
// modelcontextprotocol/ext-server-card@526201bbc80231daa40ffcdecfc9da4e54e5dc93. `./server` re-exports its public
// names, so it must not import `./server`. This module is not a package entry point.
import {
  type Fail,
  assertKnownKeys,
  deepFreeze,
  failFor,
  isPlainObject,
} from './discovery-options';
import { isResourceUrl } from './resource-url';

/**
 * The `$schema` every generated Server Card carries: the `v1` Server Card schema the card conforms to.
 */
const SERVER_CARD_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

/**
 * A JSON value: what a Server Card's `_meta` may hold.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * An icon a client can show for the server.
 */
export type ServerCardIcon = {
  /**
   * An http or https URL, or a `data:` URI with the image.
   */
  src: string;
  /**
   * The image's MIME type, such as `image/png`, when its source does not say.
   */
  mimeType?: string | undefined;
  /**
   * The sizes the icon can be shown at, each `WxH`, such as `48x48`, or `any`.
   */
  sizes?: readonly string[] | undefined;
  /**
   * The background the icon is designed for.
   */
  theme?: 'light' | 'dark' | undefined;
};

/**
 * Where the server's source code is. Leave it out for a private repository.
 */
export type ServerCardRepository = {
  /**
   * The repository's URL.
   */
  url: string;
  /**
   * The hosting service, such as `github`.
   */
  source: string;
  /**
   * A clean relative path from the repository root, such as `packages/server`. Must be nonempty, with no
   * URL scheme, absolute path, backslashes, leading or trailing `/`, empty segments, or `.` or `..` segments.
   */
  subfolder?: string | undefined;
  /**
   * The hosting service's own identifier for the repository.
   */
  id?: string | undefined;
};

/**
 * Input to `generateServerCard`: the public identity of an MCP server and the URL clients connect to. The card's
 * `$schema` and `remotes` are generated and cannot be set.
 */
export type ServerCardOptions = {
  /**
   * The server's name in reverse-DNS form, with exactly one `/`, such as `com.example/weather`. It identifies the
   * server; it is not a URL.
   */
  name: string;
  /**
   * The server's version, in 1 to 255 Unicode code points, such as `1.2.0`. Semantic versioning is recommended;
   * a range such as `^1.2.0` is rejected.
   */
  version: string;
  /**
   * What the server does, in 1 to 100 characters.
   */
  description: string;
  /**
   * The exact URL of the MCP endpoint, the streamable HTTP remote the card advertises, such as
   * `https://mcp.example.com/mcp`.
   */
  resourceUrl: string;
  /**
   * A display name, in 1 to 100 characters.
   */
  title?: string | undefined;
  /**
   * An http or https URL for the server's homepage or documentation.
   */
  websiteUrl?: string | undefined;
  /**
   * Icons a client can show for the server.
   */
  icons?: readonly ServerCardIcon[] | undefined;
  /**
   * Where the server's source code is.
   */
  repository?: ServerCardRepository | undefined;
  /**
   * Public metadata of your own. Each key needs a namespace prefix, such as `com.example/tier`, that MCP has not
   * reserved, and each value must be JSON. Never put credentials or user data here: the card is public.
   */
  _meta?: Readonly<Record<string, JsonValue>> | undefined;
  /**
   * Generated: always the `v1` Server Card schema.
   */
  $schema?: never;
  /**
   * Generated: always one streamable HTTP remote at `resourceUrl`.
   */
  remotes?: never;
};

/**
 * A Server Card, as `generateServerCard` generates it. It is frozen, all the way down.
 */
export type ServerCard = {
  readonly $schema: typeof SERVER_CARD_SCHEMA;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly title?: string;
  readonly websiteUrl?: string;
  readonly repository?: Readonly<ServerCardRepository>;
  readonly icons?: readonly Readonly<ServerCardIcon>[];
  readonly remotes: readonly [{ readonly type: 'streamable-http'; readonly url: string }];
  readonly _meta?: Readonly<Record<string, JsonValue>>;
};

/**
 * Generates an MCP Server Card, the public document a client reads before it connects to learn what the server is and
 * where to connect. It supports a subset of the Server Card extension, which is in beta: the identity fields, an
 * optional title, website, icons, repository, and namespaced `_meta`, and one static streamable HTTP remote. It
 * makes no request and needs no Clerk keys or MCP SDK.
 * @see https://github.com/modelcontextprotocol/ext-server-card
 * @param options - See `ServerCardOptions`
 * @returns The card, frozen, serializable to JSON. It throws a `Clerk error:` naming the first option the card
 * cannot have, such as an unknown key or a `$schema` of its own.
 * @example
 * ```ts
 * const card = generateServerCard({
 *   name: 'com.example/weather',
 *   version: '1.2.0',
 *   description: 'Forecasts and current conditions.',
 *   resourceUrl: 'https://mcp.example.com/mcp',
 * });
 * ```
 */
export function generateServerCard(options: ServerCardOptions): ServerCard {
  return buildServerCard('generateServerCard', options);
}

const optionKeys = new Set([
  'name',
  'version',
  'description',
  'resourceUrl',
  'title',
  'websiteUrl',
  'icons',
  'repository',
  '_meta',
]);
const generatedKeys = new Set(['$schema', 'remotes']);
const iconKeys = new Set(['src', 'mimeType', 'sizes', 'theme']);
const repositoryKeys = new Set(['url', 'source', 'subfolder', 'id']);

// The schema's `name` pattern: a reverse-DNS namespace, exactly one slash, then the server's name
const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
// What makes a version a range, which the extension rejects: an operator or wildcard. A `x` wildcard is only
// meaningful in the core version, before any prerelease or build metadata.
const VERSION_RANGE_OPERATORS = new Set(['^', '~', '<', '>', '=', '*', '|']);
const VERSION_X_WILDCARD = /(^|\.)[xX](\.|$)/;
// A `_meta` key: a prefix of dot-separated labels and a slash, then a name. A prefix whose second-to-last label is
// `modelcontextprotocol` or `mcp` is reserved for MCP.
const META_LABEL = '[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
const META_KEY = new RegExp(
  `^((?:${META_LABEL}\\.)*${META_LABEL})/((?:[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)?)$`,
);
const RESERVED_META_PREFIX = /(^|\.)(modelcontextprotocol|mcp)\.[^.]+$/;

/**
 * Validates the options of `generateServerCard`, or of a `serverCardHandler` for one of its URLs, and generates the
 * card, a frozen copy that shares nothing with the options.
 * @param caller - The entry point named in error messages
 * @param options - The options, unchecked
 * @returns The card, frozen. It throws a `Clerk error:` naming the first option the card cannot have.
 */
export function buildServerCard(caller: string, options: unknown): ServerCard {
  const fail = failFor(caller);
  if (!isPlainObject(options)) {
    return fail(
      "takes an options object with name, version, description, and resourceUrl, as generateServerCard({ name: 'com.example/weather', version: '1.0.0', description: 'Forecasts.', resourceUrl: 'https://mcp.example.com/mcp' })",
    );
  }
  assertKnownKeys(fail, options, {
    allowed: optionKeys,
    generated: generatedKeys,
    generatedMessage: (key) =>
      `cannot set ${key}: the card's $schema and its streamable HTTP remote at resourceUrl are generated`,
    unknownMessage: (key) =>
      `does not take ${key}. A Server Card supports name, version, description, resourceUrl, title, websiteUrl, icons, repository, and _meta`,
  });
  const { name, version, description, resourceUrl, title, websiteUrl, icons, repository, _meta } =
    options;

  if (
    typeof name !== 'string' ||
    name.length < 3 ||
    name.length > 200 ||
    !NAME_PATTERN.test(name)
  ) {
    fail(
      "name must be 3 to 200 characters in reverse-DNS form with exactly one slash, such as 'com.example/weather'",
    );
  }
  if (
    typeof version !== 'string' ||
    version.length === 0 ||
    [...version].length > 255 ||
    isVersionRange(version) ||
    VERSION_X_WILDCARD.test(version.split(/[-+]/, 1)[0] ?? '')
  ) {
    fail("version must be 1 to 255 characters naming one version, such as '1.2.0', not a range");
  }
  assertText(fail, 'description', description, false);
  assertText(fail, 'title', title, true);
  if (!isStaticHttpUrl(resourceUrl)) {
    fail(
      'resourceUrl must be one absolute http or https URL without credentials, a fragment, spaces, or {template} variables',
    );
  }
  if (websiteUrl !== undefined && !isHttpUrl(websiteUrl)) {
    fail('websiteUrl must be an absolute http or https URL');
  }
  if (icons !== undefined && !(Array.isArray(icons) && Array.from(icons).every(isIcon))) {
    fail(
      "icons must be a list of { src, mimeType?, sizes?, theme? }, each src an http, https, or data: URL and theme 'light' or 'dark'",
    );
  }
  if (repository !== undefined && !isRepository(repository)) {
    fail(
      'repository must be { url, source, subfolder?, id? } with an http or https url, string fields, and a clean relative subfolder (no URL scheme, absolute path, backslashes, leading or trailing /, empty segments, or . or .. segments)',
    );
  }
  if (_meta !== undefined) assertMeta(fail, _meta);

  return deepFreeze(
    JSON.parse(
      JSON.stringify({
        $schema: SERVER_CARD_SCHEMA,
        name,
        version,
        description,
        title,
        websiteUrl,
        repository,
        icons,
        remotes: [{ type: 'streamable-http', url: resourceUrl }],
        _meta,
      }),
    ),
  );
}

function isVersionRange(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== undefined && VERSION_RANGE_OPERATORS.has(character)) return true;
    if (
      character === '-' &&
      index > 0 &&
      index + 1 < value.length &&
      value[index - 1]?.trim() === '' &&
      value[index + 1]?.trim() === ''
    ) {
      return true;
    }
  }
  return false;
}

function assertText(fail: Fail, key: string, value: unknown, optional: boolean) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || value.length === 0 || [...value].length > 100) {
    fail(`${key} must be 1 to 100 characters`);
  }
}

function assertMeta(fail: Fail, meta: unknown) {
  if (!isPlainObject(meta)) fail("_meta must be an object, such as { 'com.example/tier': 'free' }");
  for (const [key, value] of Object.entries(meta as object)) {
    const match = META_KEY.exec(key);
    if (!match || RESERVED_META_PREFIX.test(match[1] as string)) {
      fail(
        `_meta key ${key} needs a namespace prefix of your own, such as 'com.example/${key}'. Prefixes whose second-to-last label is modelcontextprotocol or mcp are reserved for MCP`,
      );
    }
    if (!isJson(value, new Set())) {
      fail(
        `_meta ${key} must be JSON: strings, finite numbers, booleans, null, arrays, and plain objects, without cycles`,
      );
    }
  }
}

function isJson(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((child) => isJson(child, seen));
  seen.delete(value);
  return valid;
}

function isIcon(icon: unknown): boolean {
  if (!isPlainObject(icon) || !Object.keys(icon).every((key) => iconKeys.has(key))) return false;
  const { src, mimeType, sizes, theme } = icon;
  return (
    (isHttpUrl(src) || (isUri(src) && src.startsWith('data:'))) &&
    (mimeType === undefined || typeof mimeType === 'string') &&
    (sizes === undefined ||
      (Array.isArray(sizes) && Array.from(sizes).every((size) => typeof size === 'string'))) &&
    (theme === undefined || theme === 'light' || theme === 'dark')
  );
}

function isRepository(repository: unknown): boolean {
  if (!isPlainObject(repository)) return false;
  if (!Object.keys(repository).every((key) => repositoryKeys.has(key))) return false;
  const { url, source, subfolder, id } = repository;
  return (
    isHttpUrl(url) &&
    typeof source === 'string' &&
    source.length > 0 &&
    (subfolder === undefined || isCleanRelativePath(subfolder)) &&
    (id === undefined || typeof id === 'string')
  );
}

function isCleanRelativePath(path: unknown): boolean {
  if (typeof path !== 'string' || path.includes('\\') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

// Validate the emitted string, not WHATWG URL's repaired/escaped serialization. RFC 3986 Appendix A permits
// pchar and / in paths, plus ? in queries/fragments, with square brackets reserved for an authority's IP literal.
const PCHAR = "-a-zA-Z0-9._~!$&'()*+,;=:@%";
const URI_PATTERN = new RegExp(
  `^[a-zA-Z][a-zA-Z0-9+.-]*:(?://[${PCHAR}\\[\\]]*)?[${PCHAR}/]*(?:\\?[${PCHAR}/?]*)?(?:#[${PCHAR}/?]*)?$`,
);

function isUri(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    URI_PATTERN.test(value) &&
    !/\s|%(?![a-fA-F0-9]{2})/.test(value) &&
    URL.canParse(value)
  );
}

function isHttpUrl(value: unknown): value is string {
  return isUri(value) && /^https?:\/\//i.test(value);
}

// The remote is a URL the client connects to as it is, so it can't look like the extension's `{variable}` templates,
// and the schema's remote pattern allows no whitespace
export function isStaticHttpUrl(value: unknown): value is string {
  return isHttpUrl(value) && /^https?:\/\//.test(value) && isResourceUrl(value);
}
