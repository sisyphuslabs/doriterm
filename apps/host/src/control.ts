import type { Socket, UnixSocketListener } from "bun";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type ControlRequest, parseRequest } from "./control-requests.ts";
import { SocketWriter, type WritableSocket } from "./socket-writer.ts";

/**
 * A Unix socket in the state dir (0700) through which `doriface-host pair` and `devices revoke` reach the running
 * host: one JSON request line, one JSON reply line. Without a running host the commands fall back to the files.
 */
export const controlSocketPath = (stateDir: string): string => join(stateDir, "host.sock");

export type { ControlRequest } from "./control-requests.ts";

/** `closed` aborts when the requesting connection goes away, so a long wait (`mesh-pending`) can stop. */
export type ControlHandler = (
  request: ControlRequest,
  closed: AbortSignal,
  confirm: (code: string) => Promise<boolean>,
) => Promise<unknown>;

/** A request is one short JSON line; anything longer without a newline is refused. */
const MAX_REQUEST_BYTES = 4096;

interface ConnectionState {
  buffer: string;
  /** Decodes the connection's bytes as one stream, so a character split across two chunks arrives whole. */
  readonly decoder: TextDecoder;
  readonly closed: AbortController;
  started: boolean;
  answer: ((line: string) => void) | undefined;
  readonly out: SocketWriter;
}

const encoder = new TextEncoder();

/** Sends one JSON line after anything still queued; `end` closes the connection once all of it is written. */
function sendLine(socket: WritableSocket, out: SocketWriter, value: unknown, end = false): void {
  out.send(socket, encoder.encode(`${JSON.stringify(value)}\n`), end);
}

export interface ControlListener {
  /** Stops listening and removes the socket file. */
  stop(): void;
}

/** Whether a running host answers on this state dir's control socket (a stale socket file refuses connections). */
export async function controlIsLive(stateDir: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: controlSocketPath(stateDir), socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** Listens on the state dir's socket, replacing a stale file; check {@link controlIsLive} first. */
export function listenControl(stateDir: string, handle: ControlHandler): ControlListener {
  const unix = controlSocketPath(stateDir);
  rmSync(unix, { force: true });
  const reply = (socket: Socket<ConnectionState>, value: unknown): void =>
    sendLine(socket, socket.data.out, value, true);
  const listener: UnixSocketListener<ConnectionState> = Bun.listen<ConnectionState>({
    unix,
    socket: {
      open(socket) {
        socket.data = {
          buffer: "",
          decoder: new TextDecoder(),
          closed: new AbortController(),
          started: false,
          answer: undefined,
          out: new SocketWriter(),
        };
      },
      drain(socket) {
        socket.data.out.flush(socket);
      },
      close(socket) {
        socket.data.closed.abort(new Error("the control connection closed"));
      },
      data(socket, chunk) {
        socket.data.buffer += socket.data.decoder.decode(chunk, { stream: true });
        const lines = socket.data.buffer.split("\n");
        socket.data.buffer = lines.pop() ?? "";
        if (socket.data.buffer.length > MAX_REQUEST_BYTES || lines.some((line) => line.length > MAX_REQUEST_BYTES)) {
          socket.data.buffer = "";
          reply(socket, { ok: false, error: "request too large" });
          return;
        }
        for (const line of lines) {
          if (socket.data.started) {
            if (socket.data.answer === undefined) {
              reply(socket, { ok: false, error: "no join is waiting for an answer" });
              return;
            }
            socket.data.answer(line);
            continue;
          }
          socket.data.started = true;
          Promise.resolve()
            .then(() => {
              const request = parseRequest(line);
              return handle(request, socket.data.closed.signal, (code) => {
                if (request.op !== "mesh-join" || request.ask !== true) return Promise.resolve(false);
                const answer = Promise.withResolvers<boolean>();
                const finish = (confirmed: boolean): void => {
                  socket.data.answer = undefined;
                  socket.data.closed.signal.removeEventListener("abort", stop);
                  answer.resolve(confirmed);
                };
                const stop = (): void => finish(false);
                socket.data.answer = (raw) => {
                  try {
                    const value: unknown = JSON.parse(raw);
                    finish(typeof value === "object" && value !== null && "confirm" in value && value.confirm === true);
                  } catch {
                    finish(false);
                  }
                };
                socket.data.closed.signal.addEventListener("abort", stop, { once: true });
                if (socket.data.closed.signal.aborted) stop();
                else sendLine(socket, socket.data.out, { state: "code", code });
                return answer.promise;
              });
            })
            .then(
              (result) => reply(socket, { ok: true, result }),
              (error: unknown) =>
                reply(socket, { ok: false, error: error instanceof Error ? error.message : String(error) }),
            );
        }
      },
    },
  });
  return {
    stop() {
      listener.stop(true);
      rmSync(unix, { force: true });
    },
  };
}

/** Sends one request to the running host; resolves undefined when no host listens on this state dir. */
export async function requestControl(
  stateDir: string,
  request: ControlRequest,
  confirm?: (code: string) => Promise<boolean>,
): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let text = "";
  const decoder = new TextDecoder();
  let asked = false;
  const out = new SocketWriter();
  try {
    await Bun.connect({
      unix: controlSocketPath(stateDir),
      socket: {
        open(socket) {
          sendLine(socket, out, request);
        },
        drain(socket) {
          out.flush(socket);
        },
        data(socket, chunk) {
          text += decoder.decode(chunk, { stream: true });
          const end = text.indexOf("\n");
          if (end === -1 || asked || request.op !== "mesh-join") return;
          try {
            const line: unknown = JSON.parse(text.slice(0, end));
            if (typeof line !== "object" || line === null || !("state" in line) || line.state !== "code") return;
            if (!("code" in line) || typeof line.code !== "string") throw new Error("bad join code reply");
            asked = true;
            text = text.slice(end + 1);
            void (confirm?.(line.code) ?? Promise.resolve(false)).then(
              (answer) => sendLine(socket, out, { confirm: answer }),
              (error: unknown) => {
                socket.end();
                reject(error);
              },
            );
          } catch (error) {
            socket.end();
            reject(error);
          }
        },
        close() {
          resolve(text + decoder.decode());
        },
        error(_, error) {
          reject(error);
        },
      },
    });
  } catch {
    return undefined;
  }
  const answer: unknown = JSON.parse(await promise);
  if (typeof answer !== "object" || answer === null || !("ok" in answer)) throw new Error("bad control reply");
  if (answer.ok !== true)
    throw new Error(`the running host refused: ${"error" in answer ? String(answer.error) : "?"}`);
  return "result" in answer ? answer.result : undefined;
}
