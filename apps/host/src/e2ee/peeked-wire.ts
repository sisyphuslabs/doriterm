import { HANDSHAKE_TIMEOUT_MS, type Unsubscribe } from "@doriface/crypto";
import type { E2eeWire } from "./links.ts";

const IDLE_CLOSE = 4408;

/**
 * A session's wire with its first message read ahead, so the host can tell a resume (contract v1.11) from a handshake
 * before it runs either. Everything that arrives is kept in order until a data listener takes it: the handshake path
 * gets the first message back with the rest, and a resume takes what followed its request with `drain`.
 *
 * One subscription on the wire, made here, carries every message: held while nobody listens, then handed on. A listener
 * gets what was held on a microtask rather than inside its subscription, because the handshake subscribes before it is
 * ready for a message and would drop one delivered inside the call.
 */
export class PeekedWire implements E2eeWire {
  readonly #inner: E2eeWire;
  readonly #held: Uint8Array[] = [];
  readonly #first = Promise.withResolvers<Uint8Array>();
  #listener: ((bytes: Uint8Array) => void) | undefined;
  /** Whether what was held has been handed on: from then on a message goes straight to the listener. */
  #handedOn = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(inner: E2eeWire, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    this.#inner = inner;
    inner.onData((bytes) => {
      if (this.#handedOn) return this.#listener?.(bytes);
      const first = this.#held.length === 0;
      this.#held.push(bytes);
      if (first) this.#settle(bytes);
    });
    inner.onClose(() => this.#first.reject(new Error("the link closed before its first message")));
    this.#timer = setTimeout(() => {
      inner.close(IDLE_CLOSE, "no first message in time");
      this.#first.reject(new Error("no first message in time"));
    }, timeoutMs);
    this.#first.promise.catch(() => undefined);
  }

  /** The first message on the wire; rejects when the wire closes or stays silent past the deadline. */
  get first(): Promise<Uint8Array> {
    return this.#first.promise;
  }

  /** Takes what followed the first message, and lets it go: a data listener then gets only what arrives after. */
  drain(): Uint8Array[] {
    const [, ...later] = this.#held.splice(0);
    this.#handedOn = true;
    return later;
  }

  send(bytes: Uint8Array): void {
    this.#inner.send(bytes);
  }

  flushed(): Promise<void> {
    return this.#inner.flushed();
  }

  readWhen(gate: () => Promise<void> | undefined): void {
    this.#inner.readWhen(gate);
  }

  onData(listener: (bytes: Uint8Array) => void): Unsubscribe {
    this.#listener = listener;
    if (!this.#handedOn) {
      queueMicrotask(() => {
        if (this.#handedOn) return;
        this.#handedOn = true;
        for (const bytes of this.#held.splice(0)) this.#listener?.(bytes);
      });
    }
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  onClose(listener: (error: Error | undefined) => void): Unsubscribe {
    return this.#inner.onClose(listener);
  }

  close(code?: number, reason?: string): void {
    clearTimeout(this.#timer);
    this.#inner.close(code, reason);
  }

  #settle(first: Uint8Array): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#first.resolve(first);
  }
}
