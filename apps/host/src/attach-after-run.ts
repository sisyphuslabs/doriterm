import { FrameDecoder, FrameKind, HEADER_BYTES, RPC_CHANNEL } from "@doriface/protocol";
import type { DataHandler, Link } from "./link.ts";

const LF = 0x0a;
/** A plain line longer than this is not the hello this reads for: the connection is then passed through untouched. */
const MAX_LINE_BYTES = 64 * 1024;

type Mode = "lines" | "frames" | "off";

interface Rpc {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const decoder = new TextDecoder();

function rpcOf(bytes: Uint8Array): Rpc | undefined {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const field = (params: unknown, key: string): unknown =>
  typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;

/** The address a run's terminal answers to once started: its name, behind the machine it runs `on`. */
function addressOfRun(params: unknown): string | undefined {
  const name = field(params, "name");
  if (typeof name !== "string" || name === "") return undefined;
  const on = field(params, "on");
  return typeof on === "string" && on !== "" ? `${on}/${name}` : name;
}

function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

interface LineScan {
  readonly mode: Mode;
  readonly rest: Uint8Array;
  readonly framedAt: number | undefined;
}

function scanLines(buffer: Uint8Array, switches: (line: Rpc) => boolean): LineScan {
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

const isFramedHello = (line: Rpc): boolean => line.method === "hello" && field(line.params, "framed") === true;
const isFramedReply = (line: Rpc): boolean => line.method === undefined && field(line.result, "framed") === true;

/**
 * Wraps the link to a core so a client can send `terminal.attach` right behind the `terminal.run` that starts its
 * terminal, by the `name` that run gives it, and have the new terminal's first screen one round trip after asking for
 * it instead of two (#1351). hc runs one connection's calls side by side, so an attach that reached it with the run
 * would look the name up before the terminal exists. Here such an attach waits, unchanged, until the core has answered
 * that run, and then goes to the core; nothing else waits, and no byte is changed, added or dropped. A connection whose
 * plain lines are not the framed hello this expects is passed straight through.
 */
export function attachAfterRun(core: Link): Link {
  let up: Mode = "lines";
  let down: Mode = "lines";
  let upLines: Uint8Array = new Uint8Array(0);
  let downRest: Uint8Array = new Uint8Array(0);
  /** Header bytes of a frame already passed on, before its length is known. */
  let head: Uint8Array = new Uint8Array(0);
  /** Bytes of the frame passed on last that are still to come; they pass as they come. */
  let skip = 0;
  /** A request frame being read whole before it is passed on (or held), and the bytes it still needs. */
  let collecting: Uint8Array[] | undefined;
  let need = 0;
  const downFrames = new FrameDecoder();
  /** Unanswered runs by request id (JSON text), with the address each one's terminal will answer to. */
  const runs = new Map<string, string>();
  /** Attach frames waiting for their run, by that address, in the order they came. */
  const held = new Map<string, Uint8Array[]>();
  let closed = false;

  const release = (address: string): void => {
    if ([...runs.values()].includes(address)) return;
    const frames = held.get(address);
    held.delete(address);
    for (const frame of frames ?? []) {
      core.send(frame).catch(() => core.close());
    }
  };

  const releaseAll = (): void => {
    runs.clear();
    for (const address of held.keys()) release(address);
  };

  /** Whether this request frame is an attach to hold back; records the runs that start a named terminal. */
  const holds = (payload: Uint8Array, frame: Uint8Array): boolean => {
    const request = down === "off" ? undefined : rpcOf(payload);
    if (request === undefined || request.id === undefined || request.id === null) return false;
    if (request.method === "terminal.run") {
      const address = addressOfRun(request.params);
      if (address !== undefined) runs.set(JSON.stringify(request.id), address);
      return false;
    }
    if (request.method !== "terminal.attach") return false;
    const terminal = field(request.params, "terminal");
    if (typeof terminal !== "string" || ![...runs.values()].includes(terminal)) return false;
    held.set(terminal, [...(held.get(terminal) ?? []), frame]);
    return true;
  };

  /** A whole request frame: passed on, unless it is an attach that waits for its run. */
  const requestFrame = (frame: Uint8Array, out: Uint8Array[]): void => {
    if (!holds(frame.subarray(HEADER_BYTES), frame)) out.push(frame);
  };

  /**
   * Passes every byte on as it comes, in order, except a request frame (channel 0, data), which is read whole first so
   * an attach that waits for its run can be kept back. A frame whose header arrives split is passed on without a look.
   */
  const sendFrames = (bytes: Uint8Array, framedFrom = 0): Promise<void> => {
    const out: Uint8Array[] = [];
    let at = framedFrom;
    let runStart = 0;
    const passUpTo = (end: number): void => {
      if (end > runStart) out.push(bytes.subarray(runStart, end));
      runStart = end;
    };
    while (at < bytes.byteLength) {
      if (collecting !== undefined) {
        const take = Math.min(need, bytes.byteLength - at);
        collecting.push(bytes.slice(at, at + take));
        need -= take;
        at += take;
        runStart = at;
        if (need === 0) {
          requestFrame(collecting.reduce(joined), out);
          collecting = undefined;
        }
      } else if (skip > 0) {
        const take = Math.min(skip, bytes.byteLength - at);
        skip -= take;
        at += take;
      } else if (head.byteLength === 0 && bytes.byteLength - at >= HEADER_BYTES) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + at, HEADER_BYTES);
        const length = view.getUint32(5, true);
        if (view.getUint32(0, true) !== RPC_CHANNEL || view.getUint8(4) !== FrameKind.Data) {
          at += HEADER_BYTES;
          skip = length;
          continue;
        }
        const end = at + HEADER_BYTES + length;
        if (end > bytes.byteLength) {
          passUpTo(at);
          collecting = [];
          need = HEADER_BYTES + length;
        } else if (holds(bytes.subarray(at + HEADER_BYTES, end), bytes.slice(at, end))) {
          passUpTo(at);
          at = end;
          runStart = end;
        } else {
          at = end;
        }
      } else {
        const take = Math.min(HEADER_BYTES - head.byteLength, bytes.byteLength - at);
        head = joined(head, bytes.slice(at, at + take));
        at += take;
        if (head.byteLength === HEADER_BYTES) {
          skip = new DataView(head.buffer, head.byteOffset, HEADER_BYTES).getUint32(5, true);
          head = new Uint8Array(0);
        }
      }
    }
    passUpTo(at);
    return Promise.all(out.map((chunk) => core.send(chunk))).then(() => undefined);
  };

  /** Plain lines pass on at once; once the framed hello has gone by, what follows it goes through `sendFrames`. */
  const send = (bytes: Uint8Array): Promise<void> => {
    if (up === "frames") return sendFrames(bytes);
    if (up === "off") return core.send(bytes);
    const before = upLines.byteLength;
    const scan = scanLines(joined(upLines, bytes), isFramedHello);
    up = scan.mode;
    upLines = scan.mode === "lines" ? scan.rest : new Uint8Array(0);
    if (scan.mode === "off") releaseAll();
    if (scan.framedAt === undefined) return core.send(bytes);
    return sendFrames(bytes, scan.framedAt - before);
  };

  /** Looks at what the core sends for the replies to the runs being waited on; the bytes go on as they came. */
  const watch = (bytes: Uint8Array): void => {
    let framed = bytes;
    if (down === "lines") {
      const buffer = joined(downRest, bytes);
      const scan = scanLines(buffer, isFramedReply);
      down = scan.mode;
      downRest = scan.mode === "lines" ? scan.rest : new Uint8Array(0);
      if (scan.framedAt === undefined) {
        if (down === "off") releaseAll();
        return;
      }
      framed = buffer.subarray(scan.framedAt);
    }
    if (down !== "frames") return;
    let frames;
    try {
      frames = downFrames.push(framed);
    } catch {
      // Not frames hc would send: stop looking, and hold nothing back from here on.
      down = "off";
      releaseAll();
      return;
    }
    for (const frame of frames) {
      if (runs.size === 0) continue;
      if (frame.channel !== RPC_CHANNEL || frame.kind !== FrameKind.Data) continue;
      const reply = rpcOf(frame.payload);
      if (reply === undefined || reply.method !== undefined || reply.id === undefined) continue;
      const key = JSON.stringify(reply.id);
      const address = runs.get(key);
      if (address === undefined) continue;
      runs.delete(key);
      release(address);
    }
  };

  return {
    send: (bytes) => (closed ? core.send(bytes) : send(bytes)),
    onClose: (handler) => core.onClose(handler),
    close: () => {
      closed = true;
      held.clear();
      runs.clear();
      core.close();
    },
    onData(handler: DataHandler) {
      core.onData((bytes) => {
        if (!closed) watch(bytes);
        return handler(bytes);
      });
    },
  };
}
