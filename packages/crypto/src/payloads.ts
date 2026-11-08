import { concatBytes, utf8 } from "./encoding.ts";
import { checkName } from "./machine-name.ts";

/** Handshake payloads are one JSON line (at most 256 bytes with its LF), then raw stream bytes where allowed. */
const MAX_LINE = 256;
const MAX_DEVICE_NAME = 64;
/** IK message 1 may carry the first stream bytes, normally the hc `hello` line. */
export const MAX_EARLY_BYTES = 4096;
const MAX_LAN_URLS = 8;
const LF = 0x0a;

export class PayloadError extends Error {
  override readonly name = "PayloadError";
}

/** Control, format and line-separator characters could rewrite a terminal or a UI line that shows the name. */
const UNSAFE_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function deviceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > MAX_DEVICE_NAME) {
    throw new PayloadError(`a device name is 1-${MAX_DEVICE_NAME} characters`);
  }
  if (UNSAFE_NAME_CHARACTER.test(trimmed)) throw new PayloadError("a device name cannot contain control characters");
  if (!trimmed.isWellFormed()) throw new PayloadError("a device name cannot contain a lone surrogate");
  return trimmed;
}

/** A join's name is a mesh name: herdr-core's machine-name rule, untrimmed (contract v1.5 "Handshake payloads"). */
function meshName(name: string): string {
  if (!checkName(name)) throw new PayloadError("a mesh name is 1-32 of a-z 0-9 . _ -, starting with a letter or digit");
  return name;
}

const line = (value: object): Uint8Array => utf8(`${JSON.stringify({ v: 1, ...value })}\n`);

/** Splits off the leading JSON line, checks `v == 1`, and returns its fields and the bytes after the LF. */
function splitLine(payload: Uint8Array): {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly rest: Uint8Array;
} {
  const end = payload.subarray(0, MAX_LINE).indexOf(LF);
  if (end === -1) throw new PayloadError(`a handshake payload starts with a JSON line of at most ${MAX_LINE} bytes`);
  let fields: unknown;
  try {
    fields = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(0, end)));
  } catch (error) {
    throw new PayloadError("the handshake payload line is not UTF-8 JSON", { cause: error });
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields) || !("v" in fields) || fields.v !== 1) {
    throw new PayloadError("the handshake payload line must be a JSON object with v = 1");
  }
  return { fields: Object.fromEntries(Object.entries(fields)), rest: payload.subarray(end + 1) };
}

/**
 * What the plaintext of a session carries (contract v1.7): absent or `"hc"` is the `hc connect` stream, `"mesh"` the
 * mesh stream, `"push"` a device's push stream (web push subscriptions and notice answers). On a pairing, absent is a
 * device pairing and `"mesh"` a machine join.
 */
export type Stream = "hc" | "mesh" | "push" | "roster";

/** The mesh and push streams start with their own lines, so their message 1 carries no early bytes. */
const takesEarly = (stream: Stream | undefined): boolean => stream === undefined || stream === "hc";

const streamField = (stream: Stream | undefined): { readonly stream?: Stream } =>
  stream === undefined ? {} : { stream };

/** Pairing message 1: `{"v":1,"name":"<name>"}\n` (with `"stream":"mesh"` for a join) and nothing after it. */
export const encodePairingHello = (name: string, stream?: "mesh"): Uint8Array =>
  line({ name: stream === "mesh" ? meshName(name) : deviceName(name), ...streamField(stream) });

/** IK message 1: `{"v":1}\n` followed by up to {@link MAX_EARLY_BYTES} early stream bytes (none on the mesh stream). */
export function encodeSessionHello(early: Uint8Array = new Uint8Array(0), stream?: Stream): Uint8Array {
  if (early.byteLength > MAX_EARLY_BYTES) throw new PayloadError(`at most ${MAX_EARLY_BYTES} early bytes`);
  if (!takesEarly(stream) && early.byteLength > 0)
    throw new PayloadError(`the ${stream} stream carries no early bytes`);
  return concatBytes(line(streamField(stream)), early);
}

export type Hello =
  | { readonly kind: "pairing"; readonly name: string; readonly stream: "mesh" | undefined }
  | { readonly kind: "session"; readonly early: Uint8Array; readonly stream: Stream | undefined };

function streamOf(value: unknown, pairing: boolean): Stream | undefined {
  if (
    value === undefined ||
    value === "mesh" ||
    ((value === "hc" || value === "push" || value === "roster") && !pairing)
  )
    return value;
  throw new PayloadError(`stream ${JSON.stringify(value)} is not valid on a ${pairing ? "pairing" : "session"}`);
}

export function decodeHello(pattern: "IK" | "IKpsk2", payload: Uint8Array): Hello {
  const { fields, rest } = splitLine(payload);
  if (pattern === "IK") {
    const stream = streamOf(fields["stream"], false);
    if (rest.byteLength > MAX_EARLY_BYTES) throw new PayloadError(`at most ${MAX_EARLY_BYTES} early bytes`);
    if (!takesEarly(stream) && rest.byteLength > 0)
      throw new PayloadError(`the ${stream} stream carries no early bytes`);
    return { kind: "session", early: rest.slice(), stream };
  }
  const stream = streamOf(fields["stream"], true);
  const name = fields["name"];
  if (typeof name !== "string") throw new PayloadError('a pairing hello carries {"name": string}');
  if (rest.byteLength > 0) throw new PayloadError("a pairing hello carries nothing after its line");
  if (stream === "mesh") return { kind: "pairing", name: meshName(name), stream };
  return { kind: "pairing", name: deviceName(name), stream: undefined };
}

/** `ws://`, an IPv4 or bracketed IPv6 literal, an explicit port, `/v1/e2ee`, and nothing else. */
const LAN_URL = /^ws:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\/v1\/e2ee$/;

/** Accepts `ws://<IP literal>:<port>/v1/e2ee` only: LAN addresses are literals, never hostnames to resolve. */
function lanUrl(value: unknown): string {
  const match = typeof value === "string" ? LAN_URL.exec(value) : null;
  const port = Number(match?.[1]);
  if (typeof value !== "string" || match === null || !URL.canParse(value) || port < 1 || port > 65_535) {
    throw new PayloadError(`not a LAN e2ee URL: ${String(value)}`);
  }
  return value;
}

/** The longest leading run of `lanUrls` whose reply still fits one 256-byte line (and at most 8 entries). */
export function fitLanUrls(lanUrls: readonly string[]): readonly string[] {
  const fitted: string[] = [];
  for (const url of lanUrls.slice(0, MAX_LAN_URLS)) {
    if (line({ lan: [...fitted, lanUrl(url)] }).byteLength > MAX_LINE) break;
    fitted.push(url);
  }
  return fitted;
}

/** Message 2: `{"v":1,"lan":[…]}\n` with at most 8 IP-literal LAN URLs, and nothing after it. */
export function encodeReply(lanUrls: readonly string[]): Uint8Array {
  if (lanUrls.length > MAX_LAN_URLS) throw new PayloadError(`at most ${MAX_LAN_URLS} LAN URLs`);
  const encoded = line({ lan: lanUrls.map(lanUrl) });
  if (encoded.byteLength > MAX_LINE) throw new PayloadError(`the reply line exceeds ${MAX_LINE} bytes`);
  return encoded;
}

export function decodeReply(payload: Uint8Array): readonly string[] {
  const { fields, rest } = splitLine(payload);
  const lan = fields["lan"];
  if (rest.byteLength > 0 || !Array.isArray(lan) || lan.length > MAX_LAN_URLS) {
    throw new PayloadError('a reply is {"v":1,"lan":[…]} and nothing after it');
  }
  return lan.map(lanUrl);
}
