import { encodeCredit } from "@doriface/protocol";
import { HcConnectionClosedError } from "./errors.ts";

// Return a quarter of hc's 256 KiB window at a time. A quiet channel gets its remaining credit back too.
const STEP = 64 * 1024;
const MAX_WAIT_MS = 100;

export class CreditReturn {
  #pending = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #send: (frame: Uint8Array) => void;
  readonly #channel: number;

  constructor(channel: number, send: (frame: Uint8Array) => void) {
    this.#channel = channel;
    this.#send = send;
  }

  add(bytes: number): void {
    if (bytes === 0) return;
    this.#pending += bytes;
    if (this.#pending >= STEP) this.#flush();
    else this.#timer ??= setTimeout(() => this.#flush(), MAX_WAIT_MS);
  }

  discard(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = 0;
  }

  #flush(): void {
    const bytes = this.#pending;
    this.discard();
    try {
      this.#send(encodeCredit(this.#channel, bytes));
    } catch (error) {
      if (!(error instanceof HcConnectionClosedError)) throw error;
    }
  }
}
