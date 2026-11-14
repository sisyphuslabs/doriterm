import type { ByteLink } from "@doriface/crypto";
import type { Socket, UnixSocketListener } from "bun";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { isRecord } from "../state/files.ts";
import { SocketWriter } from "../socket-writer.ts";
import type { LineGrant } from "./line-grants.ts";

export const LINE_SOCKET = "line.sock";
/** The request line is `{"v":1,"hostId":"…"}`: anything longer is not one. */
const MAX_REQUEST_BYTES = 512;
/** Bytes the bridge may send while its grant is pending (the hc hello and a little more). */
export const MAX_EARLY_BYTES = 256 * 1024;
/** Bytes from the line the bridge may leave unread before the line is closed rather than queued without end. */
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

interface Connection {
  request: Uint8Array;
  requested: boolean;
  early: Uint8Array[];
  earlyBytes: number;
  link: ByteLink | undefined;
  closed: boolean;
  readonly out: SocketWriter;
}

export interface LineSocket {
  stop(): void;
}

function parseRequest(line: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) && value["v"] === 1 && typeof value["hostId"] === "string" ? value["hostId"] : undefined;
  } catch {
    return undefined;
  }
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
};

function send(socket: Socket<Connection>, bytes: Uint8Array | string): void {
  const state = socket.data;
  if (state.closed) return;
  const chunk = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  if (state.out.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
    return overflow(socket, "the bridge is not reading its line");
  }
  state.out.send(socket, chunk);
}

function overflow(socket: Socket<Connection>, reason: string): void {
  const state = socket.data;
  state.closed = true;
  state.out.clear();
  state.early.length = 0;
  state.link?.close(1000, reason);
  socket.end();
}

/** Keeps what the bridge sends before its grant, up to MAX_EARLY_BYTES. */
function hold(socket: Socket<Connection>, chunk: Uint8Array): void {
  const state = socket.data;
  state.earlyBytes += chunk.byteLength;
  if (state.earlyBytes > MAX_EARLY_BYTES) return overflow(socket, "too many bytes ahead of the grant");
  state.early.push(chunk);
}

/** Whether a host answers on `path`: a second host on the same state dir must not take its socket. */
async function answers(path: string): Promise<boolean> {
  try {
    const probe = await Bun.connect({ unix: path, socket: { data: () => undefined } });
    probe.end();
    return true;
  } catch {
    return false;
  }
}

async function respond(
  socket: Socket<Connection>,
  hostId: string,
  grant: (hostId: string) => Promise<LineGrant>,
  log: (line: string) => void,
): Promise<void> {
  let granted: LineGrant;
  try {
    granted = await grant(hostId);
  } catch (error) {
    log(`mesh: line grant for ${hostId} failed: ${String(error)}`);
    granted = { ok: false, code: 4404, reason: String(error) };
  }
  if (socket.data.closed) {
    if (granted.ok) granted.link.close();
    return;
  }
  if (!granted.ok) {
    send(socket, `${JSON.stringify({ ok: false, code: granted.code, reason: granted.reason })}\n`);
    socket.end();
    return;
  }
  const { link } = granted;
  send(socket, '{"ok":true}\n');
  link.onData((bytes) => send(socket, bytes));
  link.onClose(() => socket.end());
  socket.data.link = link;
  for (const bytes of socket.data.early.splice(0)) link.send(bytes);
}

/**
 * The bridge socket (section 7.2), owner-only in the 0700 state dir: one request line, one answer line, then after
 * `{"ok":true}` a raw byte pipe to the line the host dialed with its own key.
 */
export async function listenLineSocket(options: {
  readonly path: string;
  readonly grant: (hostId: string) => Promise<LineGrant>;
  readonly log: (line: string) => void;
}): Promise<LineSocket> {
  if (existsSync(options.path)) {
    if (await answers(options.path)) throw new Error(`${options.path} is in use: a doriface-host already runs here`);
    rmSync(options.path, { force: true });
  }
  const listener: UnixSocketListener<Connection> = Bun.listen<Connection>({
    unix: options.path,
    socket: {
      open(socket) {
        socket.data = {
          request: new Uint8Array(0),
          requested: false,
          early: [],
          earlyBytes: 0,
          link: undefined,
          closed: false,
          out: new SocketWriter(),
        };
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.link !== undefined) return state.link.send(chunk);
        if (state.requested) return hold(socket, chunk);
        state.request = concat(state.request, chunk);
        const end = state.request.indexOf(0x0a);
        if (end === -1) {
          if (state.request.byteLength > MAX_REQUEST_BYTES) socket.end();
          return;
        }
        const hostId = parseRequest(new TextDecoder().decode(state.request.subarray(0, end)));
        const rest = state.request.slice(end + 1);
        state.requested = true;
        state.request = new Uint8Array(0);
        hold(socket, rest);
        if (hostId === undefined) {
          send(socket, '{"ok":false,"code":4400,"reason":"a line.sock request is one JSON line {v:1,hostId}"}\n');
          return void socket.end();
        }
        void respond(socket, hostId, options.grant, options.log);
      },
      drain(socket) {
        socket.data.out.flush(socket);
      },
      close(socket) {
        socket.data.closed = true;
        socket.data.link?.close();
      },
      error(_socket, error) {
        options.log(`mesh: line.sock connection: ${error.message}`);
      },
    },
  });
  chmodSync(options.path, 0o600);
  return {
    stop() {
      listener.stop(true);
      rmSync(options.path, { force: true });
    },
  };
}
