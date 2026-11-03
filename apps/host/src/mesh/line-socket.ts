import type { ByteLink } from "@doriface/crypto";
import type { Socket, UnixSocketListener } from "bun";
import { chmodSync, rmSync } from "node:fs";
import { isRecord } from "../state/files.ts";
import type { LineGrant } from "./mesh-lines.ts";

export const LINE_SOCKET = "line.sock";
/** The request line is `{"v":1,"hostId":"…"}`: anything longer is not one. */
const MAX_REQUEST_BYTES = 512;

interface Connection {
  request: Uint8Array;
  early: Uint8Array[];
  link: ByteLink | undefined;
  closed: boolean;
  readonly outgoing: Uint8Array[];
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

/** Writes what the socket takes now; the rest waits for `drain`, in order. */
function flush(socket: Socket<Connection>): void {
  const queue = socket.data.outgoing;
  for (let head = queue[0]; head !== undefined; head = queue[0]) {
    const written = socket.write(head);
    if (written < head.byteLength) {
      queue[0] = head.subarray(Math.max(0, written));
      return;
    }
    queue.shift();
  }
}

function send(socket: Socket<Connection>, bytes: Uint8Array | string): void {
  socket.data.outgoing.push(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
  flush(socket);
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
export function listenLineSocket(options: {
  readonly path: string;
  readonly grant: (hostId: string) => Promise<LineGrant>;
  readonly log: (line: string) => void;
}): LineSocket {
  rmSync(options.path, { force: true });
  const listener: UnixSocketListener<Connection> = Bun.listen<Connection>({
    unix: options.path,
    socket: {
      open(socket) {
        socket.data = { request: new Uint8Array(0), early: [], link: undefined, closed: false, outgoing: [] };
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.link !== undefined) return state.link.send(chunk);
        if (state.request.byteLength > MAX_REQUEST_BYTES) return void state.early.push(chunk);
        state.request = concat(state.request, chunk);
        const end = state.request.indexOf(0x0a);
        if (end === -1) {
          if (state.request.byteLength > MAX_REQUEST_BYTES) socket.end();
          return;
        }
        const hostId = parseRequest(new TextDecoder().decode(state.request.subarray(0, end)));
        state.early.push(state.request.slice(end + 1));
        state.request = new Uint8Array(MAX_REQUEST_BYTES + 1);
        if (hostId === undefined) {
          send(socket, '{"ok":false,"code":4400,"reason":"a line.sock request is one JSON line {v:1,hostId}"}\n');
          return void socket.end();
        }
        void respond(socket, hostId, options.grant, options.log);
      },
      drain: flush,
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
