import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { isRecord } from "../state/files.ts";
import type { Output } from "./pipe.ts";

export const LINE_SOCKET_NAME = "line.sock";

export interface MeshBridgeOptions {
  readonly stateDir: string;
  readonly hostId: string;
  readonly input: AsyncIterable<Uint8Array>;
  readonly output: Output;
  readonly log: (line: string) => void;
}

type Answer = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function parseAnswer(line: string): Answer {
  const value: unknown = JSON.parse(line);
  if (isRecord(value) && value["ok"] === true) return { ok: true };
  const reason = isRecord(value) && typeof value["reason"] === "string" ? value["reason"] : "the host refused the line";
  return { ok: false, reason };
}

/** Connects to line.sock and reads the one-line answer; leftover bytes after it are the line's first bytes. */
function request(path: string, hostId: string): Promise<{ socket: Socket; answer: Answer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end === -1) return;
      socket.off("data", onData);
      socket.pause();
      try {
        resolve({
          socket,
          answer: parseAnswer(buffered.subarray(0, end).toString("utf8")),
          rest: buffered.subarray(end + 1),
        });
      } catch (error) {
        reject(error);
      }
    };
    socket.once("connect", () => socket.write(`${JSON.stringify({ v: 1, hostId })}\n`));
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("the host closed line.sock before answering")));
  });
}

const notRunning = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED");

/**
 * `doriface-host connect --mesh <hostId>` (section 7.2): asks the running host for a line to a member over
 * `<state dir>/line.sock`, then pipes stdin and stdout through it byte for byte. The host dials with its own Noise key;
 * this process holds no key. Every refusal is one line on stderr and exit 1.
 */
export async function meshBridge(options: MeshBridgeOptions): Promise<number> {
  let opened: Awaited<ReturnType<typeof request>>;
  try {
    opened = await request(join(options.stateDir, LINE_SOCKET_NAME), options.hostId);
  } catch (error) {
    options.log(notRunning(error) ? "doriface-host is not running" : `line.sock: ${String(error)}`);
    return 1;
  }
  const { socket, answer, rest } = opened;
  if (!answer.ok) {
    options.log(answer.reason);
    socket.destroy();
    return 1;
  }
  const ended = Promise.withResolvers<number>();
  if (rest.byteLength > 0) options.output.write(rest);
  socket.on("data", (bytes: Buffer) => {
    if (!options.output.write(bytes)) {
      socket.pause();
      void options.output.drained().then(() => socket.resume());
    }
  });
  socket.once("close", () => ended.resolve(0));
  socket.once("error", (error) => {
    options.log(`the line ended: ${error.message}`);
    ended.resolve(1);
  });
  socket.resume();
  void (async () => {
    for await (const chunk of options.input)
      if (!socket.write(chunk)) await new Promise((r) => socket.once("drain", r));
    socket.end();
  })();
  const code = await ended.promise;
  await options.output.drained();
  return code;
}
