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
import type { PairSlotSignature } from "@doriface/relay-client/wire";

export class RelaySessionClosed extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`the host closed the session with ${code}`);
    this.code = code;
  }
}

export type PairSlotSeen = NonNullable<ReturnType<typeof decodePairSlotRequest>> | "clear";

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
  #hostId = "";
  #signPub: Uint8Array | undefined;
  #registered:
    | { readonly slot: string; readonly noiseStaticPub: Uint8Array; readonly signed?: PairSlotSignature }
    | undefined;

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
      // The relay passes the client's close code on to the host (contract: a normal close is 1000, a drop is not).
      close: (code = 1000) => {
        this.#send(encodeClose(sessionId, code));
        session.closed.resolve(code);
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
      // The relay knows the host's signing key from this answer; so does this one, for the code lookup it answers.
      if (message.byteLength === 96) {
        this.#hostId = hostId;
        this.#signPub = message.slice(0, 32);
      }
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
    if (request === "clear") this.#registered = undefined;
    else {
      this.#lastSlot = request.slot;
      this.#registered = request;
    }
    this.pairSlots.push(request);
    this.#sendOrThrow(encodePairSlotAck(this.#lastSlot, PairSlotAckStatus.Registered));
  }

  /**
   * What the relay answers at `GET /v1/pair/<slot>`: the signed record the host registered for it (#22), with the
   * signing key it presented on its uplink. Undefined when no host holds that slot or its record is unsigned.
   */
  pairLookup(slot: string):
    | {
        readonly hostId: string;
        readonly noiseStaticPub: string;
        readonly signPub: string;
        readonly expiresAt: number;
        readonly slotSig: string;
      }
    | undefined {
    const registered = this.#registered;
    const signPub = this.#signPub;
    if (registered === undefined || signPub === undefined) return undefined;
    if (registered.slot !== slot || registered.signed === undefined) return undefined;
    return {
      hostId: this.#hostId,
      noiseStaticPub: base64urlFor(registered.noiseStaticPub),
      signPub: base64urlFor(signPub),
      expiresAt: registered.signed.expiresAt,
      slotSig: base64urlFor(registered.signed.signature),
    };
  }
}

const base64urlFor = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
