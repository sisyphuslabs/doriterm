import { isJsonObject } from "./json.ts";
import { isMeshName } from "./mesh-name.ts";

// Type guards the status document parser is built from. Any client can overwrite the document, so every value it
// carries is checked for its exact form: hostIds, names, fingerprints and times, not only their JSON types.

export type Guard<T> = (value: unknown) => value is T;
export type Shape<T> = { readonly [K in keyof T]-?: Guard<T[K]> };

export const isString = (value: unknown): value is string => typeof value === "string";
export const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** A hostId or meshId: 16 bytes in lowercase base32, 26 characters. */
export const isId = (value: unknown): value is string => isString(value) && /^[a-z2-7]{26}$/.test(value);
export const isName = (value: unknown): value is string => isString(value) && isMeshName(value);
/** A Noise key fingerprint as `fingerprint` prints it: 10 groups of 4 uppercase hex digits. */
export const isFingerprint = (value: unknown): value is string =>
  isString(value) && /^([0-9A-F]{4} ){9}[0-9A-F]{4}$/.test(value);
/** An ISO 8601 UTC time, the form `Date.prototype.toISOString` writes (milliseconds optional). */
export const isTime = (value: unknown): value is string =>
  isString(value) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

export const nullable =
  <T>(guard: Guard<T>): Guard<T | null> =>
  (value): value is T | null =>
    value === null || guard(value);
export const listOf =
  <T>(guard: Guard<T>): Guard<readonly T[]> =>
  (value): value is readonly T[] =>
    Array.isArray(value) && value.every(guard);
export const oneOf =
  <T extends string>(...values: readonly T[]): Guard<T> =>
  (value): value is T =>
    values.some((allowed) => allowed === value);

/** Exactly the members the shape names, each own and each of its form; any other member refuses the object. */
export function objectOf<T>(shape: Shape<T>): Guard<T> {
  return (value): value is T => {
    if (!isJsonObject(value)) return false;
    if (!Object.keys(value).every((key) => Object.hasOwn(shape, key))) return false;
    for (const key in shape) if (!shape[key](Object.hasOwn(value, key) ? value[key] : undefined)) return false;
    return true;
  };
}
