/** A WebSocket a test drives by hand: it opens, sends and closes when the test says so, never on its own. */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readonly protocols: readonly string[];
  binaryType = "blob";
  readyState = FakeSocket.CONNECTING;
  /** Every `send` this socket saw; a ping the link sends while open lands here. */
  readonly sent: (string | Uint8Array)[] = [];
  /** Runs on every `send`, so a test can read the moment a host would have received the bytes. */
  onSend: ((data: string | Uint8Array) => void) | undefined;
  /** The code the link closed this socket with, or undefined when nothing closed it. */
  closedWith: number | undefined;
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string, protocols: readonly string[] = []) {
    this.url = url;
    this.protocols = protocols;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(
      type,
      listeners.filter((each) => each !== listener),
    );
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  /** Closes as a browser socket does: the close event follows the call, before it returns. */
  close(code?: number, reason = ""): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    // A close with no code reaches the page as 1005 (no status received).
    this.closedWith = code ?? 1005;
    this.#fire("close", { code: this.closedWith, reason });
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.#fire("open", {});
  }

  #fire(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

export interface FakeWebSockets {
  readonly created: FakeSocket[];
  restore(): void;
}

/**
 * Replaces the global `WebSocket` for one test. `openWebSocketLink` reads the constructor and `WebSocket.OPEN` when it
 * runs, so a test can hand it a socket that opens on command instead of a real network.
 */
export function fakeWebSockets(): FakeWebSockets {
  const native = globalThis.WebSocket;
  const created: FakeSocket[] = [];
  class TrackedSocket extends FakeSocket {
    constructor(url: string, protocols: readonly string[] = []) {
      super(url, protocols);
      created.push(this);
    }
  }
  Object.assign(globalThis, { WebSocket: TrackedSocket as unknown as typeof WebSocket });
  return {
    created,
    restore: () => Object.assign(globalThis, { WebSocket: native }),
  };
}
