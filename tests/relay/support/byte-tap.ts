import type { ByteLink, Unsubscribe } from "@doriface/client";
import { type Frame, FrameDecoder, FrameKind, RPC_CHANNEL } from "@doriface/protocol";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TAP_SCRIPT = join(import.meta.dir, "hc-tap.ts");

/** An `hc` that records each `hc connect`'s bytes in `dir`; it carries its own settings, since `hc --version` runs without the host's env. */
export function tappedHc(dir: string, realHc: string): string {
  mkdirSync(join(dir, "taps"), { recursive: true });
  const hc = join(dir, "hc-tap");
  const settings = `DORIFACE_REAL_HC='${realHc}' DORIFACE_TAP_DIR='${join(dir, "taps")}'`;
  writeFileSync(hc, `#!/bin/sh\n${settings} exec '${process.execPath}' '${TAP_SCRIPT}' "$@"\n`);
  chmodSync(hc, 0o755);
  return hc;
}

export interface Tap {
  /** The tapped `hc connect`'s pid, which names its files. */
  readonly pid: string;
  readonly read: Uint8Array;
  readonly wrote: Uint8Array;
}

export function taps(dir: string): Tap[] {
  const folder = join(dir, "taps");
  const file = (name: string): Uint8Array => {
    try {
      return new Uint8Array(readFileSync(join(folder, name)));
    } catch (error) {
      // A side that has not written yet has no file; any other read error is a broken tap, not an empty one.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Uint8Array(0);
      throw error;
    }
  };
  const pids = new Set(readdirSync(folder).map((name) => name.split(".")[0] ?? ""));
  return [...pids].map((pid) => ({ pid, read: file(`${pid}.in`), wrote: file(`${pid}.out`) }));
}

/** Where what the client received first differs from what hc wrote: hc's bytes are the expected ones. */
export const replyDifference = (tap: Tap, received: Uint8Array): string | undefined =>
  firstDifference(tap.wrote, received);

/**
 * The tap of the connection that sent `sent`: the one whose input starts with the most frames that match it (byte for
 * byte, or a run the host added its token to), then the longest shared prefix. A host connection of its own starts with
 * the same hello, so the frames, not the bytes, tell them apart once the client's run carries a token.
 */
export function tapFor(all: readonly Tap[], sent: Uint8Array): Tap | undefined {
  const shared = (read: Uint8Array): number => {
    let length = 0;
    while (length < read.byteLength && length < sent.byteLength && read[length] === sent[length]) length += 1;
    return length;
  };
  const score = (read: Uint8Array): readonly [number, number] => [matchingFrames(sent, read), shared(read)];
  return all.toSorted((a, b) => {
    const [aFrames, aBytes] = score(a.read);
    const [bFrames, bBytes] = score(b.read);
    return bFrames - aFrames || bBytes - aBytes;
  })[0];
}

/** Where two byte strings first differ, with a little context from each; undefined when equal. */
export function firstDifference(expected: Uint8Array, actual: Uint8Array): string | undefined {
  const length = Math.min(expected.byteLength, actual.byteLength);
  let offset = 0;
  while (offset < length && expected[offset] === actual[offset]) offset += 1;
  if (offset === length && expected.byteLength === actual.byteLength) return undefined;
  const around = (bytes: Uint8Array): string =>
    JSON.stringify(new TextDecoder().decode(bytes.subarray(Math.max(0, offset - 24), offset + 24)));
  return `byte ${offset} of ${expected.byteLength}/${actual.byteLength}: expected ${around(expected)}, got ${around(actual)}`;
}

const TOKEN_VAR = "OSC7577_TOKEN";
const LF = 0x0a;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsed = (payload: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
};

/**
 * The exact bytes the host sends for the client's `sent` run once it adds `token` (the transform run-tokens.ts makes:
 * the client's members in their order, `env` with the token set); undefined when `sent` is no run the host may token,
 * a run on another machine (`on`) included.
 */
function tokenedRun(sent: Uint8Array, token: string): Uint8Array | undefined {
  const request = parsed(sent);
  if (!isObject(request) || request["method"] !== "terminal.run") return undefined;
  if (request["id"] === undefined || request["id"] === null) return undefined;
  const params = request["params"] ?? {};
  if (!isObject(params) || (typeof params["on"] === "string" && params["on"] !== "")) return undefined;
  const env = params["env"] ?? {};
  if (!isObject(env)) return undefined;
  return new TextEncoder().encode(
    JSON.stringify({ ...request, params: { ...params, env: { ...env, [TOKEN_VAR]: token } } }),
  );
}

/** Where the plain hello line ends and frames begin. */
const helloEnd = (bytes: Uint8Array): number => bytes.indexOf(LF) + 1;

/** The token hc read in a run's `params.env`, or undefined. */
function tokenIn(read: Uint8Array): string | undefined {
  const request = parsed(read);
  const params = isObject(request) ? request["params"] : undefined;
  const env = isObject(params) ? params["env"] : undefined;
  const token = isObject(env) ? env[TOKEN_VAR] : undefined;
  return typeof token === "string" ? token : undefined;
}

/** Whether hc read `got` for the client's `frame`: the same bytes, or the run the host made of it with a token. */
function frameMatches(frame: Frame, got: Frame): boolean {
  if (frame.channel !== got.channel || frame.kind !== got.kind) return false;
  if (firstDifference(frame.payload, got.payload) === undefined) return true;
  const token = frame.channel === RPC_CHANNEL && frame.kind === FrameKind.Data ? tokenIn(got.payload) : undefined;
  const expected = token === undefined ? undefined : tokenedRun(frame.payload, token);
  return expected !== undefined && firstDifference(expected, got.payload) === undefined;
}

const framesOf = (bytes: Uint8Array): Frame[] => new FrameDecoder().push(bytes.subarray(helloEnd(bytes)));

/** How many of the client's frames, from the first, hc read as `frameMatches` allows. */
function matchingFrames(sent: Uint8Array, read: Uint8Array): number {
  const [sentFrames, readFrames] = [framesOf(sent), framesOf(read)];
  let count = 0;
  while (count < sentFrames.length && count < readFrames.length) {
    const [frame, got] = [sentFrames[count], readFrames[count]];
    if (frame === undefined || got === undefined || !frameMatches(frame, got)) break;
    count += 1;
  }
  return count;
}

/**
 * Where what hc read first differs from what the client sent, frame by frame (docs/transport.md, "What the host adds"):
 * every frame must arrive byte for byte, except that a `terminal.run` request for this core may arrive as exactly the
 * bytes the host makes of it with an `OSC7577_TOKEN` in its env (program resume, docs/program-resume.md), and nothing
 * else. Undefined when that holds.
 */
export function requestDifference(sent: Uint8Array, read: Uint8Array): string | undefined {
  const [sentHello, readHello] = [helloEnd(sent), helloEnd(read)];
  const hello = firstDifference(sent.subarray(0, sentHello), read.subarray(0, readHello));
  if (hello !== undefined) return `the hello line: ${hello}`;
  const [sentFrames, readFrames] = [framesOf(sent), framesOf(read)];
  if (sentFrames.length !== readFrames.length) return `${sentFrames.length} frames sent, ${readFrames.length} read`;
  for (const [index, frame] of sentFrames.entries()) {
    const got = readFrames[index];
    if (got === undefined) return `frame ${index} was not read`;
    if (frameMatches(frame, got)) continue;
    if (frame.channel !== got.channel || frame.kind !== got.kind) return `frame ${index} changed its channel or kind`;
    return `frame ${index}: ${firstDifference(frame.payload, got.payload) ?? ""}`;
  }
  return undefined;
}

/** A ByteLink that keeps every byte sent and received, captured from the first byte on. */
export class RecordingLink implements ByteLink {
  readonly #link: ByteLink;
  readonly #sent: Uint8Array[] = [];
  readonly #received: Uint8Array[] = [];
  readonly #listeners = new Set<(bytes: Uint8Array) => void>();

  constructor(link: ByteLink) {
    this.#link = link;
    link.onData((bytes) => {
      this.#received.push(bytes.slice());
      for (const listener of this.#listeners) listener(bytes);
    });
  }

  get sent(): Uint8Array {
    return concat(this.#sent);
  }

  get received(): Uint8Array {
    return concat(this.#received);
  }

  send(bytes: Uint8Array): void {
    this.#sent.push(bytes.slice());
    this.#link.send(bytes);
  }

  onData(listener: (bytes: Uint8Array) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: (error: Error | undefined) => void): Unsubscribe {
    return this.#link.onClose(listener);
  }

  close(): void {
    this.#link.close();
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
