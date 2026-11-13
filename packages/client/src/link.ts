import { Listeners, type Unsubscribe } from "./listeners.ts";

/**
 * A reliable, ordered byte pipe to one herdr-core connection. The host WebSocket, an E2EE
 * session, `hc connect` over stdio and in-memory tests all implement it. `onClose` fires once,
 * with an error when the link failed rather than ended.
 */
export interface ByteLink {
  send(bytes: Uint8Array): void;
  onData(listener: (bytes: Uint8Array) => void): Unsubscribe;
  onClose(listener: (error: Error | undefined) => void): Unsubscribe;
  close(): void;
  /**
   * The connection found the link silent or gone. A link that can carry on over a new socket (a resumable session)
   * takes the loss and returns true: the connection stays open and waits. Absent or false, the connection closes.
   */
  lost?(reason: Error): boolean;
}

export class LinkClosedError extends Error {
  override readonly name = "LinkClosedError";
}

class MemoryLinkEnd implements ByteLink {
  readonly #data = new Listeners<Uint8Array>();
  readonly #close = new Listeners<Error | undefined>();
  #closed = false;
  peer: MemoryLinkEnd | undefined;

  send(bytes: Uint8Array): void {
    const peer = this.peer;
    if (this.#closed || peer === undefined) throw new LinkClosedError("memory link is closed");
    const copy = bytes.slice();
    queueMicrotask(() => peer.#data.emit(copy));
  }

  onData(listener: (bytes: Uint8Array) => void): Unsubscribe {
    return this.#data.add(listener);
  }

  onClose(listener: (error: Error | undefined) => void): Unsubscribe {
    return this.#close.add(listener);
  }

  close(): void {
    this.end(undefined);
  }

  end(error: Error | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.#close.emit(error));
    this.peer?.end(error);
  }
}

/** Two linked ends: bytes sent on one arrive, in order and on a later microtask, at the other. */
export function createMemoryLinkPair(): readonly [ByteLink, ByteLink] {
  const a = new MemoryLinkEnd();
  const b = new MemoryLinkEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
