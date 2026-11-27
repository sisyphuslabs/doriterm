import type { ByteLink } from "./link.ts";
import { relaySocketUrl } from "./socket.ts";
import { WebSocketLink } from "./websocket-link.ts";

/** Open only the separately budgeted relay route. Never fall back to an ordinary client socket. */
export async function restoreLink(relayUrl: string, hostId: string): Promise<WebSocketLink> {
  if (!/^[a-z2-7]{26}$/.test(hostId)) throw new Error("invalid restore host id");
  const wire = new WebSocket(relaySocketUrl(relayUrl, `/v1/restore/${hostId}`));
  const link = new WebSocketLink(wire);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const open = () => resolve();
  wire.addEventListener("open", open, { once: true });
  const close = link.onClose(() => reject(new Error("the relay does not have this restore holder")));
  const timer = setTimeout(() => reject(new Error("the restore holder did not connect")), 10_000);
  try {
    await promise;
    return link;
  } catch (error) {
    link.close();
    throw error;
  } finally {
    clearTimeout(timer);
    close();
    wire.removeEventListener("open", open);
  }
}

/** Subscribe before writing so a fast peer cannot race the reply. */
export async function readRestoreMessage(
  link: ByteLink,
  expected: number,
  send?: () => void | Promise<void>,
): Promise<Uint8Array> {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  const timer = setTimeout(() => reject(new Error("restore request timed out")), 10_000);
  const offData = link.onData((data) => {
    if (data.byteLength !== expected) reject(new RangeError("invalid restore message length"));
    else resolve(data);
  });
  const offClose = link.onClose(() => reject(new Error("the restore link closed")));
  try {
    if (send !== undefined) void Promise.resolve(send()).catch(reject);
    return await promise;
  } finally {
    clearTimeout(timer);
    offData();
    offClose();
  }
}
