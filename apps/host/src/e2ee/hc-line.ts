/** hc 0.1.17's protocol generation: a hello naming another one is refused by hc and leaves the connection plain. */
const HC_GENERATION = 1;
/** serde_json refuses nesting deeper than 128; anything past this is refused here first, so hc never parses more. */
const MAX_DEPTH = 64;
/** Integer literals small enough that serde_json and JSON.parse read the same value; any other number is refused. */
const INTEGER = /^-?(?:0|[1-9]\d{0,14})$/;

/**
 * One plain-mode hc line as hc 0.1.17 reads it (`server.rs` `connection`). A `hello` that will switch the
 * connection to frames is the one line whose `params.core` registers a peer line (`remote.rs` `peer_joined`).
 */
export type HcLine =
  | { readonly kind: "call"; readonly method: string }
  | { readonly kind: "hello"; readonly coreId: string | undefined; readonly framed: boolean }
  | { readonly kind: "malformed"; readonly reason: string };

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HIGH = /^\\u[dD][89abAB][0-9a-fA-F]{2}$/;
const LOW = /^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/;

/**
 * Why serde_json would refuse `text` where JSON.parse would not, checked over every token rather than the parsed
 * value, so a value a duplicate key overwrites is checked too (hc keeps the last value of a duplicate key, as
 * JSON.parse does, but serde refuses the whole line over any token): nesting past {@link MAX_DEPTH}, a lone surrogate
 * escape, or a number that is not a small integer literal.
 */
function lexicalRefusal(text: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] !== "\\") j++;
        else if (text[j + 1] !== "u") j += 2;
        else {
          const escape = text.slice(j, j + 6);
          const pairs = HIGH.test(escape) && LOW.test(text.slice(j + 6, j + 12));
          if ((HIGH.test(escape) && !pairs) || LOW.test(escape)) return "a lone surrogate";
          j += pairs ? 12 : 6;
        }
      }
      i = j + 1;
    } else if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      NUMBER.lastIndex = i;
      const token = NUMBER.exec(text)?.[0] ?? c;
      if (!INTEGER.test(token)) return "not a small integer";
      i += token.length;
    } else {
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
      if (depth > MAX_DEPTH) return "nested too deeply";
      i++;
    }
  }
  return undefined;
}

/** JSON both parsers read alike; a leading byte order mark is kept, so JSON.parse refuses it as serde does. */
function parseStrict(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const refusal = lexicalRefusal(text);
  if (refusal !== undefined) throw new Error(refusal);
  return JSON.parse(text);
}

const optional = (value: unknown, is: (value: unknown) => boolean): boolean =>
  value === undefined || value === null || is(value);
const isString = (value: unknown): boolean => typeof value === "string";
const isCore = (value: unknown): boolean => isObject(value) && isString(value["id"]) && isString(value["name"]);
const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every(isString);

/**
 * `HelloParams` exactly as hc deserializes it, so a hello read here as framed is one hc switches on. Unknown
 * fields are ignored by hc and here.
 */
function helloOf(params: unknown): HcLine {
  if (params === undefined || params === null) return { kind: "hello", coreId: undefined, framed: false };
  if (!isObject(params)) return { kind: "malformed", reason: "hello params must be an object" };
  const { generation, framed, core, calls_you: callsYou, features } = params;
  const valid =
    optional(generation, (g) => g === HC_GENERATION) &&
    (framed === undefined || typeof framed === "boolean") &&
    optional(core, isCore) &&
    optional(callsYou, isString) &&
    (features === undefined || isStrings(features));
  if (!valid) return { kind: "malformed", reason: "hello params hc would refuse" };
  const coreId = isObject(core) && typeof core["id"] === "string" ? core["id"] : undefined;
  return { kind: "hello", coreId, framed: framed === true };
}

/** Reads one plain-mode line (without its LF) as a JSON-RPC 2.0 request, refusing what hc could read otherwise. */
export function hcLineOf(bytes: Uint8Array): HcLine {
  let request: unknown;
  try {
    request = parseStrict(bytes);
  } catch {
    return { kind: "malformed", reason: "not a JSON-RPC request" };
  }
  if (!isObject(request) || request["jsonrpc"] !== "2.0" || typeof request["method"] !== "string") {
    return { kind: "malformed", reason: "not a JSON-RPC request" };
  }
  const { id, method } = request;
  if (id === null || (id !== undefined && typeof id !== "string" && typeof id !== "number")) {
    return { kind: "malformed", reason: "a JSON-RPC id must be a string or an integer" };
  }
  if (method !== "hello") return { kind: "call", method };
  if (id === undefined) return { kind: "malformed", reason: "a hello must carry an id" };
  return helloOf(request["params"]);
}
