/**
 * The plain JSON-RPC lines a connection to a core starts with, read up to the framed hello (and its reply) after
 * which the connection is frames (`attachAfterRun`).
 */

const LF = 0x0a;
/** A plain line longer than this is not the hello this reads for: the connection is then passed through untouched. */
const MAX_LINE_BYTES = 64 * 1024;

export type Mode = "lines" | "frames" | "off";

export interface Rpc {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const decoder = new TextDecoder();

export function rpcOf(bytes: Uint8Array): Rpc | undefined {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export const field = (params: unknown, key: string): unknown =>
  typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;

export function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

export interface LineScan {
  readonly mode: Mode;
  readonly rest: Uint8Array;
  readonly framedAt: number | undefined;
}

export function scanLines(buffer: Uint8Array, switches: (line: Rpc) => boolean): LineScan {
  let start = 0;
  for (;;) {
    const end = buffer.indexOf(LF, start);
    if (end === -1) {
      const rest = buffer.slice(start);
      return { mode: rest.byteLength > MAX_LINE_BYTES ? "off" : "lines", rest, framedAt: undefined };
    }
    const line = rpcOf(buffer.subarray(start, end));
    if (line === undefined) return { mode: "off", rest: new Uint8Array(0), framedAt: undefined };
    start = end + 1;
    if (switches(line)) return { mode: "frames", rest: new Uint8Array(0), framedAt: start };
  }
}

export const isFramedHello = (line: Rpc): boolean => line.method === "hello" && field(line.params, "framed") === true;
export const isFramedReply = (line: Rpc): boolean => line.method === undefined && field(line.result, "framed") === true;
