import { join } from "node:path";
import { within } from "../watch.ts";
import type { MeshHost } from "./mesh-host.ts";

const ANSWER_MS = 20_000;

export interface HeldLine {
  /** Resolves when the host ends the line. */
  readonly closed: Promise<void>;
  isOpen(): boolean;
  close(): void;
}

/**
 * Asks `host` for an outbound line to `to` over its `line.sock`, exactly as `connect --mesh` does (section 7.2), and
 * holds it. The host dials with its own key and registers the line, so revoking `to` must close it (R-13); no hc
 * machine stands behind it, so the reconciler's `machine.rm` cannot be what closes it.
 */
export async function holdLine(host: MeshHost, to: MeshHost): Promise<HeldLine> {
  const answer = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>();
  let open = true;
  let text = "";
  const socket = await Bun.connect({
    unix: join(host.stateDir, "line.sock"),
    socket: {
      data(_socket, bytes) {
        text += Buffer.from(bytes).toString("utf8");
        const end = text.indexOf("\n");
        if (end >= 0) answer.resolve(text.slice(0, end));
      },
      close() {
        open = false;
        answer.reject(new Error(`${host.name} closed line.sock before answering`));
        closed.resolve();
      },
      error() {
        open = false;
        closed.resolve();
      },
    },
  });
  socket.write(`${JSON.stringify({ v: 1, hostId: to.hostId })}\n`);
  const reply: unknown = JSON.parse(await within(answer.promise, `${host.name}'s line grant to ${to.name}`, ANSWER_MS));
  if (typeof reply !== "object" || reply === null || !("ok" in reply) || reply.ok !== true) {
    socket.end();
    throw new Error(`${host.name} refused a line to ${to.name}: ${JSON.stringify(reply)}`);
  }
  return { closed: closed.promise, isOpen: () => open, close: () => void socket.end() };
}
