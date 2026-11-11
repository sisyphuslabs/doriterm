import { useRef } from "react";

/** Whether two values built from JSON-like data (primitives, arrays, plain objects) hold the same data. */
export function samePlain(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => samePlain(item, b[index]));
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && samePlain(Reflect.get(a, key), Reflect.get(b, key)));
}

/**
 * The value the render before returned while it holds the same data, so a context or memo keyed on it does not change
 * for a rebuild that changed nothing. Every tab stays mounted, so a context value that changed on each terminal event
 * made React look through every pane for its readers on each of them (#2086).
 */
export function useSteady<T>(value: T): T {
  const kept = useRef(value);
  if (kept.current !== value && !samePlain(kept.current, value)) kept.current = value;
  return kept.current;
}
