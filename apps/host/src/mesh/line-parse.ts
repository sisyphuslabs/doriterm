import { base64urlDecode, base64urlEncode } from "@doriface/crypto";
import { MAX_BODY_BYTES, type Signed } from "@doriface/mesh";
import type { MeshLine } from "./lines.ts";

// The contract's shapes (transport section on mesh lines, design section 3.1), checked as a line is parsed so that a
// session's count caps are also its byte bounds: a record is at most 2048 bytes of body and 86 characters of
// signature, a hash or key is 43. The spelling must be the one canonical unpadded base64url form.
const HASH_CHARS = 43;
const SIG_CHARS = 86;
const encoder = new TextEncoder();
const canonical = (value: string, chars: number): boolean =>
  value.length === chars && /^[A-Za-z0-9_-]*$/.test(value) && base64urlEncode(base64urlDecode(value)) === value;
const fitsBody = (text: string): boolean =>
  text.length <= MAX_BODY_BYTES && encoder.encode(text).byteLength <= MAX_BODY_BYTES;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (value: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};
const signedOf = (value: unknown): Signed | undefined => {
  if (!isObject(value)) return undefined;
  const [body, sig] = [stringOf(value, "body"), stringOf(value, "sig")];
  return body === undefined || sig === undefined ? undefined : { body, sig };
};

const stringsOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
/**
 * The mesh-file formats a peer says it reads. A hello without the field is a peer that did not say; a malformed one is
 * refused rather than read as support, because the point of the field is the gate that keeps an old reader from holding
 * a record it cannot understand (design of #942, section 4).
 */
const readsOf = (value: unknown): number[] | undefined | false => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return false;
  return value.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0) ? value : false;
};
const hashesOf = (value: unknown): string[] | undefined => {
  const hashes = stringsOf(value);
  return hashes?.every((hash) => canonical(hash, HASH_CHARS)) === true ? hashes : undefined;
};

function countersOf(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isObject(value)) return undefined;
  const counters: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) {
    if (!canonical(key, HASH_CHARS) || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return undefined;
    counters[key] = n;
  }
  return counters;
}

function recordsOf(value: unknown): Signed[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: Signed[] = [];
  for (const item of value) {
    const record = signedOf(item);
    if (record === undefined || !fitsBody(record.body) || !canonical(record.sig, SIG_CHARS)) return undefined;
    records.push(record);
  }
  return records;
}

/** A known line, `"unknown"` for a `t` this host does not know (ignored), or undefined when malformed. */
export function parseLine(text: string): MeshLine | "unknown" | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const get = (key: string): string | undefined => stringOf(value, key);
  switch (value["t"]) {
    case "hello": {
      const [mesh, heads, n] = [get("mesh"), hashesOf(value["heads"]), countersOf(value["n"])];
      const reads = readsOf(value["reads"]);
      return value["v"] !== 2 || mesh === undefined || heads === undefined || n === undefined || reads === false
        ? undefined
        : { t: "hello", v: 2, mesh, heads, n, reads };
    }
    case "want": {
      const hashes = hashesOf(value["hashes"]);
      return hashes === undefined ? undefined : { t: "want", hashes };
    }
    case "offer": {
      const [mesh, inviter, nonce] = [get("mesh"), get("inviter"), get("nonce")];
      return mesh === undefined || inviter === undefined || nonce === undefined
        ? undefined
        : { t: "offer", mesh, inviter, nonce };
    }
    case "card": {
      const card = signedOf(value);
      return card === undefined ? undefined : { t: "card", ...card };
    }
    case "records": {
      const records = recordsOf(value["records"]);
      return records === undefined ? undefined : { t: "records", records };
    }
    case "done": {
      const mesh = get("mesh");
      return mesh === undefined ? undefined : { t: "done", mesh };
    }
    case "refused": {
      const reason = get("reason");
      return reason === undefined ? undefined : { t: "refused", reason };
    }
    default:
      return typeof value["t"] === "string" ? "unknown" : undefined;
  }
}
