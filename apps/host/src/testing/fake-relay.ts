import { type ByteLink, relayOriginOf, type Unsubscribe, verifyRelayAnswer } from "@doriface/crypto";
import {
  CHALLENGE_BYTES,
  decodeMux,
  decodePairSlotRequest,
  encodeClose,
  encodeData,
  encodeOpen,
  encodePairSlotAck,
  MuxType,
  PairSlotAckStatus,
  parseAck,
  PING,
} from "@doriface/relay-client";
import type { Server, ServerWebSocket } from "bun";

export class RelaySessionClosed extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`the host closed the session with ${code}`);
    this.code = code;
  }
}

export type PairSlotSeen = { readonly slot: string; readonly noiseStaticPub: Uint8Array } | "clear";

interface Uplink {
  /** False for a client socket (`/v1/client/<hostId>`): this relay serves no client of its own, so it answers 4404. */
  readonly uplink: boolean;
  readonly hostId: string;
  readonly challenge: Uint8Array;
  readonly origin: string;
  answered: boolean;
}

interface Session {
  readonly data: Set<(bytes: Uint8Array) => void>;
  readonly closed: PromiseWithResolvers<number>;
}

class Inbox<T> {
  readonly #items: T[] = [];
  #waiter: ((value: T) => void) | undefined;

  push(value: T): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter === undefined) this.#items.push(value);
    else waiter(value);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }
}

/** A stand-in for the relay's host side: challenge auth, mux frames, PAIR_SLOT acks and `a:<n>` bookkeeping. */
export class FakeRelay {
  readonly url: string;
  readonly answers = new Inbox<{ readonly hostId: string; readonly verified: boolean }>();
  readonly pairSlots = new Inbox<PairSlotSeen>();
  readonly acks = new Inbox<number>();
  /** Binary bytes sent to the current uplink, challenge included: what its `a:<n>` acks count. */
  sentToHost = 0;
  readonly #server: Server<Uplink>;
  readonly #sessions = new Map<number, Session>();
  #host: ServerWebSocket<Uplink> | undefined;
  #lastSlot = "000";

  constructor() {
    this.#server = Bun.serve<Uplink>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        const [, , role, hostId = ""] = new URL(request.url).pathname.split("/");
        const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
        const data = {
          uplink: role !== "client",
          hostId,
          challenge,
          origin: relayOriginOf(request.url),
          answered: false,
        };
        return server.upgrade(request, { data }) ? undefined : new Response("upgrade", { status: 426 });
      },
      websocket: {
        open: (ws) => {
          if (!ws.data.uplink) return ws.close(4404, "host offline");
          this.#host = ws;
          this.sentToHost = 0;
          this.#sendOrThrow(ws.data.challenge);
        },
        message: (ws, message) => this.#receive(ws, message),
        close: (ws) => {
          if (this.#host === ws) this.#host = undefined;
        },
      },
    });
    this.url = `http://127.0.0.1:${this.#server.port ?? 0}`;
  }

  open(sessionId: number, pairSlot?: string): ByteLink & { readonly closed: Promise<number> } {
    const session: Session = { data: new Set(), closed: Promise.withResolvers() };
    this.#sessions.set(sessionId, session);
    if (!this.#send(encodeOpen(sessionId, pairSlot))) session.closed.resolve(4404);
    return {
      closed: session.closed.promise,
      send: (bytes) => {
        if (!this.#send(encodeData(sessionId, bytes))) session.closed.resolve(4404);
      },
      onData: (listener): Unsubscribe => {
        session.data.add(listener);
        return () => session.data.delete(listener);
      },
      onClose: (listener): Unsubscribe => {
        let active = true;
        const notify = async (): Promise<void> => {
          const code = await session.closed.promise;
          if (active) listener(code === 1000 ? undefined : new RelaySessionClosed(code));
        };
        void notify();
        return () => {
          active = false;
        };
      },
      close: () => {
        this.#send(encodeClose(sessionId, 1000));
        session.closed.resolve(1000);
      },
    };
  }

  sendRaw(bytes: Uint8Array): void {
    this.#sendOrThrow(bytes);
  }

  dropUplink(code: number): void {
    this.#host?.close(code, "dropped by the test");
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  /** False when no uplink is connected: a client session then ends 4404, as the relay answers for an offline host. */
  #send(bytes: Uint8Array): boolean {
    const host = this.#host;
    if (host === undefined) return false;
    this.sentToHost += bytes.byteLength;
    host.send(bytes);
    return true;
  }

  #sendOrThrow(bytes: Uint8Array): void {
    if (!this.#send(bytes)) throw new Error("no uplink is connected");
  }

  #receive(ws: ServerWebSocket<Uplink>, message: string | Uint8Array): void {
    if (typeof message === "string") {
      if (message === PING) return;
      const total = parseAck(message);
      if (total === undefined) throw new Error(`unexpected text ${message}`);
      return this.acks.push(total);
    }
    if (!ws.data.answered) {
      ws.data.answered = true;
      const { origin, hostId, challenge } = ws.data;
      return this.answers.push({ hostId, verified: verifyRelayAnswer(origin, hostId, challenge, message) });
    }
    const frame = decodeMux(message);
    if (frame.type === MuxType.PairSlot) return this.#pairSlot(frame.payload);
    if (frame.type === MuxType.Data)
      for (const listener of this.#sessions.get(frame.sessionId)?.data ?? []) listener(frame.payload);
    if (frame.type === MuxType.Close) this.#sessions.get(frame.sessionId)?.closed.resolve(frame.code);
  }

  #pairSlot(payload: Uint8Array): void {
    const request = payload.byteLength === 0 ? "clear" : decodePairSlotRequest(payload);
    if (request === undefined) throw new Error("malformed PAIR_SLOT");
    if (request !== "clear") this.#lastSlot = request.slot;
    this.pairSlots.push(request);
    this.#sendOrThrow(encodePairSlotAck(this.#lastSlot, PairSlotAckStatus.Registered));
  }
}
