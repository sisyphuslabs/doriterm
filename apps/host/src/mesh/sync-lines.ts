import { type ByteLink, CloseCode, type Unsubscribe } from "@doriface/crypto";
import { LineDecoder } from "@doriface/protocol";
import { isRecord } from "../state/files.ts";
import type { MeshRecord } from "./upstream.ts";

/** Section 5.2: every mesh stream line is at most 256 KiB. */
export const MAX_LINE_BYTES = 256 * 1024;

export type MeshMessage =
  | {
      readonly t: "hello";
      readonly v: 2;
      readonly mesh: string;
      readonly heads: readonly string[];
      readonly n: Readonly<Record<string, number>>;
    }
  | { readonly t: "want"; readonly hashes: readonly string[] }
  | { readonly t: "records"; readonly records: readonly MeshRecord[] }
  | { readonly t: "done" };

export class MeshStreamError extends Error {
  override readonly name = "MeshStreamError";
}

const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const counters = (value: unknown): value is Readonly<Record<string, number>> =>
  isRecord(value) && Object.values(value).every((n) => typeof n === "number" && Number.isSafeInteger(n));

const meshRecord = (value: unknown): value is MeshRecord =>
  isRecord(value) && typeof value["body"] === "string" && typeof value["sig"] === "string";

/** Parses one line. Unknown `t` values are ignored (undefined); anything malformed throws (close 4400). */
export function parseMessage(line: string): MeshMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new MeshStreamError("a mesh stream line is not JSON");
  }
  if (!isRecord(value) || typeof value["t"] !== "string") throw new MeshStreamError("a mesh stream line has no t");
  const { t } = value;
  if (t === "hello") {
    const { v, mesh, heads, n } = value;
    if (v === 2 && typeof mesh === "string" && strings(heads) && counters(n)) return { t, v, mesh, heads, n };
  } else if (t === "want") {
    if (strings(value["hashes"])) return { t, hashes: value["hashes"] };
  } else if (t === "records") {
    const records = value["records"];
    if (Array.isArray(records) && records.every(meshRecord)) return { t, records };
  } else if (t === "done") {
    return { t };
  } else {
    return undefined;
  }
  throw new MeshStreamError(`a malformed ${t} line`);
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

/** `records` lines of at most MAX_LINE_BYTES each, then `done` (section 5.2). */
export function recordLines(records: readonly MeshRecord[]): readonly MeshMessage[] {
  const out: MeshMessage[] = [];
  let batch: MeshRecord[] = [];
  let size = byteLength('{"t":"records","records":[]}\n');
  const base = size;
  for (const record of records) {
    const cost = byteLength(JSON.stringify(record)) + 1;
    if (batch.length > 0 && size + cost > MAX_LINE_BYTES) {
      out.push({ t: "records", records: batch });
      batch = [];
      size = base;
    }
    batch.push(record);
    size += cost;
  }
  if (batch.length > 0) out.push({ t: "records", records: batch });
  out.push({ t: "done" });
  return out;
}

/** A mesh stream over a session's bytes: LF-terminated JSON lines in each direction. */
export interface MeshChannel {
  send(message: MeshMessage): void;
  onMessage(listener: (message: MeshMessage) => void): Unsubscribe;
  onClose(listener: (error: Error | undefined) => void): Unsubscribe;
  close(code?: number, reason?: string): void;
}

export function meshChannel(link: ByteLink): MeshChannel {
  const decoder = new LineDecoder(MAX_LINE_BYTES);
  const listeners = new Set<(message: MeshMessage) => void>();
  const fail = (error: unknown): void => {
    const reason = error instanceof Error ? error.message : String(error);
    link.close(CloseCode.CryptoFailure, reason);
  };
  link.onData((bytes) => {
    try {
      for (const line of decoder.push(bytes)) {
        const message = parseMessage(line);
        if (message !== undefined) for (const listener of listeners) listener(message);
      }
    } catch (error) {
      fail(error);
    }
  });
  return {
    send(message) {
      const line = `${JSON.stringify(message)}\n`;
      if (byteLength(line) > MAX_LINE_BYTES) throw new MeshStreamError("a mesh stream line exceeds 256 KiB");
      link.send(encoder.encode(line));
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: (listener) => link.onClose(listener),
    close: (code, reason) => link.close(code, reason),
  };
}
