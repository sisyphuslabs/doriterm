// I-JSON (RFC 7493) as the door needs it: well-formed text, no duplicate member names, every number a safe integer.

export type JsonObject = Readonly<Record<string, unknown>>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function onlySafeIntegers(value: unknown): boolean {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(onlySafeIntegers);
  if (isObject(value)) return Object.values(value).every(onlySafeIntegers);
  return true;
}

/** Scans text that already parsed as JSON for an object with the same member name twice (after unescaping). */
function hasDuplicateMember(text: string): boolean {
  const objects: (Set<string> | undefined)[] = [];
  let expectName = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const names = objects.at(-1);
      if (expectName && names !== undefined) {
        const decoded: unknown = JSON.parse(text.slice(i, end + 1));
        if (typeof decoded !== "string" || names.has(decoded)) return true;
        names.add(decoded);
        expectName = false;
      }
      i = end + 1;
      continue;
    }
    if (c === "{") {
      objects.push(new Set());
      expectName = true;
    } else if (c === "[") objects.push(undefined);
    else if (c === "}" || c === "]") objects.pop();
    else if (c === ",") expectName = objects.at(-1) !== undefined;
    i++;
  }
  return false;
}

export function parseIJsonObject(text: string): JsonObject | undefined {
  if (!text.isWellFormed()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isObject(value) || !onlySafeIntegers(value) || hasDuplicateMember(text)) return undefined;
  return value;
}
