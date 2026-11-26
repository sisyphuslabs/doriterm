import type { ByteLink, Unsubscribe } from "@doriface/client";
import { FrameDecoder, FrameKind, RPC_CHANNEL } from "@doriface/protocol";
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

/** The tap of the connection that sent `sent`: the one whose input shares the longest prefix with it. */
export function tapFor(all: readonly Tap[], sent: Uint8Array): Tap | undefined {
  const shared = (read: Uint8Array): number => {
    let length = 0;
    while (length < read.byteLength && length < sent.byteLength && read[length] === sent[length]) length += 1;
    return length;
  };
  return all.toSorted((a, b) => shared(b.read) - shared(a.read))[0];
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

const hasToken = (payload: Uint8Array): boolean => new TextDecoder().decode(payload).includes(`"${TOKEN_VAR}"`);

/** JSON with object keys sorted, so two requests compare by content, not by key order. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/**
 * A request payload as content, with `terminal.run`'s env read without its OSC 7577 token and an empty env dropped,
 * so a run the host added a token to equals the run the client sent; undefined for anything but a `terminal.run`.
 */
function requestContent(payload: Uint8Array): string | undefined {
  let request: unknown;
  try {
    request = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
  if (typeof request !== "object" || request === null || Reflect.get(request, "method") !== "terminal.run") {
    return undefined;
  }
  const params: unknown = Reflect.get(request, "params") ?? {};
  if (typeof params !== "object" || params === null) return undefined;
  const env: unknown = Reflect.get(params, "env");
  const kept =
    typeof env === "object" && env !== null ? Object.entries(env).filter(([key]) => key !== TOKEN_VAR) : undefined;
  const rest = Object.entries(params).filter(([key]) => key !== "env");
  const normal = kept === undefined || kept.length === 0 ? rest : [...rest, ["env", Object.fromEntries(kept)]];
  return stable({ ...request, params: Object.fromEntries(normal) });
}

/**
 * Where what hc read first differs from what the client sent, frame by frame (docs/transport.md, "What the host adds"):
 * every frame must arrive byte for byte, except that a `terminal.run` request may carry an added `OSC7577_TOKEN` in its
 * env (program resume, docs/program-resume.md) and nothing else changed in it. Undefined when that holds.
 */
/** Where the plain hello line ends and frames begin. */
const helloEnd = (bytes: Uint8Array): number => bytes.indexOf(LF) + 1;

export function requestDifference(sent: Uint8Array, read: Uint8Array): string | undefined {
  const [sentHello, readHello] = [helloEnd(sent), helloEnd(read)];
  const hello = firstDifference(sent.subarray(0, sentHello), read.subarray(0, readHello));
  if (hello !== undefined) return `the hello line: ${hello}`;
  const sentFrames = new FrameDecoder().push(sent.subarray(sentHello));
  const readFrames = new FrameDecoder().push(read.subarray(readHello));
  if (sentFrames.length !== readFrames.length) return `${sentFrames.length} frames sent, ${readFrames.length} read`;
  for (const [index, frame] of sentFrames.entries()) {
    const got = readFrames[index];
    if (got === undefined) return `frame ${index} was not read`;
    if (frame.channel !== got.channel || frame.kind !== got.kind) return `frame ${index} changed its channel or kind`;
    if (firstDifference(frame.payload, got.payload) === undefined) continue;
    const request = frame.channel === RPC_CHANNEL && frame.kind === FrameKind.Data;
    const content = request ? requestContent(frame.payload) : undefined;
    if (content !== undefined && content === requestContent(got.payload) && hasToken(got.payload)) continue;
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
