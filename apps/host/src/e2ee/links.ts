import type { ByteLink, SecureSession, Unsubscribe } from "@doriface/crypto";
import { ByteQueue, type DataHandler, type Link } from "../link.ts";
import type { WsLink } from "../ws-link.ts";

/** A transport a session's record layer runs on, with the backpressure `plaintextLink` needs: a socket or a relay session. */
export interface E2eeWire extends ByteLink, Wire {}

/**
 * A server WebSocket as the crypto layer's ByteLink. `send` is fire-and-forget there, so the socket writes stay
 * reachable through `flushed`, which settles once every write so far has; that is how the host waits for Bun's drain
 * before reading more.
 */
export class WsByteLink<T> implements E2eeWire {
  readonly #ws: WsLink<T>;
  #pending: Promise<void> = Promise.resolve();
  #gate: () => Promise<void> | undefined = () => undefined;

  constructor(ws: WsLink<T>) {
    this.#ws = ws;
  }

  send(bytes: Uint8Array): void {
    const sent = this.#ws.send(bytes);
    sent.catch(() => this.#ws.close(1011, "send failed"));
    this.#pending = Promise.all([this.#pending, sent]).then(() => undefined);
    this.#pending.catch(() => undefined);
  }

  flushed(): Promise<void> {
    return this.#pending;
  }

  /** While `gate` returns a promise, the socket reads no further message (and pauses once more arrive). */
  readWhen(gate: () => Promise<void> | undefined): void {
    this.#gate = gate;
  }

  onData(listener: (bytes: Uint8Array) => void): Unsubscribe {
    let active = true;
    this.#ws.onData((bytes) => {
      if (active) listener(bytes);
      return this.#gate();
    });
    return () => {
      active = false;
    };
  }

  onClose(listener: (error: Error | undefined) => void): Unsubscribe {
    let active = true;
    this.#ws.onClose(() => {
      if (active) listener(undefined);
    });
    return () => {
      active = false;
    };
  }

  close(code?: number, reason?: string): void {
    this.#ws.close(code, reason);
  }
}

/** The socket side `plaintextLink` needs: its write backpressure and a way to hold its reads. */
export interface Wire {
  flushed(): Promise<void>;
  readWhen(gate: () => Promise<void> | undefined): void;
}

/** What `plaintextLink` needs of a session: its plaintext both ways, and the wire it runs on as that changes. */
export type PlaintextSession = Pick<
  SecureSession,
  "send" | "onData" | "onClose" | "close" | "onLink" | "attached" | "link"
>;

/** Whether a session's link is one of the host's wires, with the backpressure `plaintextLink` needs. */
const isWire = (link: ByteLink | undefined): link is ByteLink & Wire =>
  link !== undefined && "flushed" in link && "readWhen" in link;

/**
 * The decrypted session as the host's Link, so `bridge` pipes it to `hc connect` exactly like `/v1/hc`. While
 * `hc connect` is still taking an earlier chunk, the socket stops reading, so decrypted data cannot pile up. The
 * session may change wires (a resume, contract v1.11): each new one gets the same read gate, and a write made while the
 * session has no wire waits for the next one, so `hc connect`'s output stops at the session's ring instead of piling up.
 */
export function plaintextLink(secure: PlaintextSession, wire: Wire): Link {
  let backlog: PromiseWithResolvers<void> | undefined;
  const release = (): void => {
    backlog?.resolve();
    backlog = undefined;
  };
  const inbox = new ByteQueue({
    onBacklog: () => {
      backlog ??= Promise.withResolvers();
    },
    onDrained: release,
    onError: () => secure.close(1011, "internal error"),
  });
  const gate = (): Promise<void> | undefined => backlog?.promise;
  wire.readWhen(gate);
  secure.onLink((link) => {
    if (isWire(link)) link.readWhen(gate);
  });
  secure.onData((bytes) => inbox.push(bytes));
  return {
    async send(bytes) {
      secure.send(bytes);
      await secure.attached();
      const current = secure.link;
      await (isWire(current) ? current : wire).flushed();
    },
    onData(handler: DataHandler) {
      inbox.setHandler(handler);
    },
    onClose(handler) {
      secure.onClose(() => handler());
    },
    close() {
      inbox.clear();
      release();
      secure.close();
    },
  };
}
