import { isJsonObject } from "./json.ts";
import { isMeshName } from "./mesh-name.ts";

// Readers the status document parser is built from. Any client can overwrite the document, so every value it carries
// is checked for its exact form: hostIds, names, fingerprints and times, not only their JSON types. Objects are open
// (#728): a key a newer writer added is dropped, at every level, so a reader built before a field keeps reading a
// document that carries it. Changing the form of a field a reader knows is a new MESH_STATUS_VERSION, never an edit.
// A closed set read with `oneOfOrUnknown` is open the same way (#1139): a value a newer writer added reads as `unknown`.

/** The value in its form, without any key the reader does not know; undefined when it has another form. */
export type Reader<T> = (value: unknown) => T | undefined;
export type Shape<T> = { readonly [K in keyof T]-?: Reader<T[K]> };

export const when =
  <T>(test: (value: unknown) => value is T): Reader<T> =>
  (value) =>
    test(value) ? value : undefined;

const isString = (value: unknown): value is string => typeof value === "string";
export const readString = when(isString);
export const readCount = when(
  (value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
);
export const readBoolean = when((value): value is boolean => typeof value === "boolean");

/** A hostId or meshId: 16 bytes in lowercase base32, 26 characters. */
export const readId = when((value): value is string => isString(value) && /^[a-z2-7]{26}$/.test(value));
export const readName = when((value): value is string => isString(value) && isMeshName(value));
/** A Noise key fingerprint as `fingerprint` prints it: 10 groups of 4 uppercase hex digits. */
export const readFingerprint = when(
  (value): value is string => isString(value) && /^([0-9A-F]{4} ){9}[0-9A-F]{4}$/.test(value),
);
/** An ISO 8601 UTC time, the form `Date.prototype.toISOString` writes (milliseconds optional). */
export const readTime = when(
  (value): value is string =>
    isString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)),
);

export const nullable =
  <T>(read: Reader<T>): Reader<T | null> =>
  (value) =>
    value === null ? null : read(value);
export const listOf =
  <T>(read: Reader<T>): Reader<readonly T[]> =>
  (value) => {
    if (!Array.isArray(value)) return undefined;
    const items: T[] = [];
    for (const item of value) {
      const known = read(item);
      if (known === undefined) return undefined;
      items.push(known);
    }
    return items;
  };
export const oneOf = <T extends string>(...values: readonly T[]): Reader<T> =>
  when((value): value is T => values.some((allowed) => allowed === value));
/** One of the values, or `unknown` for any other string; a value that is not a string has another form. */
export const oneOfOrUnknown =
  <T extends string>(...values: readonly T[]): Reader<T | "unknown"> =>
  (value) =>
    typeof value !== "string" ? undefined : (oneOf(...values)(value) ?? "unknown");

/** Every member the shape names, each own and each of its form; members it does not name are dropped. */
export function objectOf<T>(shape: Shape<T>): Reader<T> {
  return (value) => {
    if (!isJsonObject(value)) return undefined;
    const known: Partial<Record<keyof T, unknown>> = {};
    for (const key in shape) {
      const read = shape[key](Object.hasOwn(value, key) ? value[key] : undefined);
      if (read === undefined) return undefined;
      known[key] = read;
    }
    // Every key of the shape was read in its form above, which is what T is made of.
    return known as T;
  };
}
