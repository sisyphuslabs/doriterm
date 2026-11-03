/** hc 0.1.17's protocol generation: a hello naming another one is refused by hc and leaves the connection plain. */
const HC_GENERATION = 1;
/** serde_json refuses nesting deeper than 128; anything past this is refused here first, so hc never parses more. */
const MAX_DEPTH = 64;
/** Integers small enough that serde_json and JSON.parse read the same value; anything else is refused. */
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

function depthOf(text: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") deepest = Math.max(deepest, ++depth);
    else if (c === "}" || c === "]") depth--;
  }
  return deepest;
}

/**
 * JSON both parsers read alike: well-formed strings and keys, and only small integer literals as numbers, anywhere in
 * the line (serde_json refuses a whole line over one number like `1e400`, even in a field hc ignores).
 */
function parseStrict(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (depthOf(text) > MAX_DEPTH) throw new Error("nested too deeply");
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (!key.isWellFormed()) throw new Error("a key with a lone surrogate");
    if (typeof value === "string" && !value.isWellFormed()) throw new Error("a string with a lone surrogate");
    if (typeof value === "number" && !INTEGER.test(context?.source ?? "")) throw new Error("not a small integer");
    return value;
  });
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
