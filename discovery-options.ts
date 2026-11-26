// What the discovery builders and responders share to check the options they are given and freeze what they generate.
// It imports nothing, so `./server`, which re-exports the builders, and `./bearer-auth` stay out of its graph. This
// module is not a package entry point.

/**
 * Throws a `Clerk error:` message naming the entry point, the form every discovery option error takes.
 */
export type Fail = (message: string) => never;

/**
 * The `fail` function of an entry point, which throws `Clerk error: <caller> <message>`.
 * @param caller - The entry point named in error messages, such as `generateServerCard`
 * @returns The function that throws
 */
export function failFor(caller: string): Fail {
  return (message) => {
    throw new Error(`Clerk error: ${caller} ${message}`);
  };
}

/**
 * Whether a value is a plain object, one whose prototype is `Object.prototype` or `null`, as an options object or a
 * JSON object is. Arrays, class instances, and `null` are not.
 * @param value - The value, unchecked
 * @returns `true` for a plain object
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Freezes a value and every object it holds, so a generated document can't be changed after it is returned.
 * @param value - A JSON value the caller owns, sharing nothing with the options
 * @returns The same value, frozen all the way down
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Fails on the first key of `object`, in order, that is generated, then on one that is not allowed, so a mistyped or
 * unsupported option is never ignored.
 * @param fail - The entry point's `fail`
 * @param object - The options object, or one of its entries
 * @param keys - The keys that may be set and the message for any other, and the generated keys that cannot be set,
 * if any, with their message
 */
export function assertKnownKeys(
  fail: Fail,
  object: Record<string, unknown>,
  keys: {
    allowed: ReadonlySet<string>;
    generated?: { keys: ReadonlySet<string>; message: (key: string) => string };
    unknownMessage: (key: string) => string;
  },
) {
  for (const key of Object.keys(object)) {
    if (keys.generated?.keys.has(key)) fail(keys.generated.message(key));
    if (!keys.allowed.has(key)) fail(keys.unknownMessage(key));
  }
}
