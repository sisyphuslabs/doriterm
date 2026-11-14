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

export type PairSlotSeen = NonNullable<ReturnType<typeof decodePairSlotRequest>> | "clear";

interface Uplink {
  /** False for a client socket (`/v1/client/<hostId>`). */
  readonly uplink: boolean;
  readonly hostId: string;
  readonly challenge: Uint8Array;
  readonly origin: string;
  answered: boolean;
  readonly sessions: Map<number, Session>;
  readonly pairSlot: string | undefined;
  sent: number;
  lastSlot: string;
  signPub?: Uint8Array;
  registered?: Exclude<PairSlotSeen, "clear">;
  client?: ByteLink;
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
  /** Binary bytes sent to the first host's uplink, for the single-host accounting specs. */
  get sentToHost(): number {
    return this.#hosts.get(this.#defaultHost)?.data.sent ?? 0;
  }
  readonly #server: Server<Uplink>;
  readonly #hosts = new Map<string, ServerWebSocket<Uplink>>();
  #defaultHost = "";
  #nextSession = 100;

  constructor() {
    this.#server = Bun.serve<Uplink>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        const [, , role, hostId = ""] = url.pathname.split("/");
        const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
        const data = {
          uplink: role !== "client",
          hostId,
          challenge,
          origin: relayOriginOf(request.url),
          answered: false,
          sessions: new Map<number, Session>(),
          pairSlot: url.searchParams.get("pair") ?? undefined,
          sent: 0,
          lastSlot: "000",
        };
        return server.upgrade(request, { data }) ? undefined : new Response("upgrade", { status: 426 });
      },
      websocket: {
        open: (ws) => {
          if (!ws.data.uplink) {
            const client = this.openClient(ws.data.hostId, ws.data.pairSlot);
            ws.data.client = client;
            client.onData((bytes) => ws.send(bytes));
            void client.closed.then((code) => ws.close(code, ""));
            return;
          }
          const previous = this.#hosts.get(ws.data.hostId);
          previous?.close(1011, "uplink replaced");
          this.#hosts.set(ws.data.hostId, ws);
          this.#defaultHost ||= ws.data.hostId;
          this.#sendOrThrow(ws.data.challenge, ws.data.hostId);
        },
        message: (ws, message) => this.#receive(ws, message),
        // A client socket's own close code reaches the host, as the real relay passes it on: a drop stays a drop there.
        close: (ws, code) => {
          if (!ws.data.uplink) return ws.data.client?.close(code);
          if (this.#hosts.get(ws.data.hostId) === ws) this.#hosts.delete(ws.data.hostId);
          for (const session of ws.data.sessions.values()) session.closed.resolve(4404);
          ws.data.sessions.clear();
        },
      },
    });
    this.url = `http://127.0.0.1:${this.#server.port ?? 0}`;
  }

  /** A client from either relay listener gets a session id shared by both listeners. */
  openClient(hostId: string, pairSlot?: string): ReturnType<FakeRelay["open"]> {
    return this.open(this.#nextSession++, pairSlot, hostId);
  }

  open(
    sessionId: number,
    pairSlot?: string,
    hostId = this.#defaultHost,
  ): ByteLink & { readonly closed: Promise<number> } {
    const session: Session = { data: new Set(), closed: Promise.withResolvers() };
    const host = this.#hosts.get(hostId);
    host?.data.sessions.set(sessionId, session);
    const send = (bytes: Uint8Array): boolean =>
      host !== undefined && this.#hosts.get(hostId) === host && this.#send(bytes, hostId);
    if (!send(encodeOpen(sessionId, pairSlot))) session.closed.resolve(4404);
    return {
      closed: session.closed.promise,
      send: (bytes) => {
        if (!send(encodeData(sessionId, bytes))) session.closed.resolve(4404);
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
        send(encodeClose(sessionId, code));
        host?.data.sessions.delete(sessionId);
        session.closed.resolve(code);
      },
    };
  }

  sendRaw(bytes: Uint8Array): void {
    this.#sendOrThrow(bytes);
  }

  dropUplink(code: number, reason = "dropped by the test", hostId = this.#defaultHost): void {
    this.#hosts.get(hostId)?.close(code, reason);
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  /** False when no uplink is connected: a client session then ends 4404, as the relay answers for an offline host. */
  #send(bytes: Uint8Array, hostId = this.#defaultHost): boolean {
    const host = this.#hosts.get(hostId);
    if (host === undefined) return false;
    host.data.sent += bytes.byteLength;
    host.send(bytes);
    return true;
  }

  #sendOrThrow(bytes: Uint8Array, hostId = this.#defaultHost): void {
    if (!this.#send(bytes, hostId)) throw new Error("no uplink is connected");
  }

  #receive(ws: ServerWebSocket<Uplink>, message: string | Uint8Array): void {
    if (!ws.data.uplink) {
      if (typeof message !== "string") ws.data.client?.send(message);
      else if (message === PING) ws.send("pong");
      return;
    }
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
        ws.data.signPub = message.slice(0, 32);
      }
      return this.answers.push({ hostId, verified: verifyRelayAnswer(origin, hostId, challenge, message) });
    }
    const frame = decodeMux(message);
    if (frame.type === MuxType.PairSlot) return this.#pairSlot(ws, frame.payload);
    if (frame.type === MuxType.Data)
      for (const listener of ws.data.sessions.get(frame.sessionId)?.data ?? []) listener(frame.payload);
    if (frame.type === MuxType.Close) {
      ws.data.sessions.get(frame.sessionId)?.closed.resolve(frame.code);
      ws.data.sessions.delete(frame.sessionId);
    }
  }

  #pairSlot(ws: ServerWebSocket<Uplink>, payload: Uint8Array): void {
    const request = payload.byteLength === 0 ? "clear" : decodePairSlotRequest(payload);
    if (request === undefined) throw new Error("malformed PAIR_SLOT");
    if (request === "clear") delete ws.data.registered;
    else {
      ws.data.lastSlot = request.slot;
      ws.data.registered = request;
    }
    this.pairSlots.push(request);
    this.#sendOrThrow(encodePairSlotAck(ws.data.lastSlot, PairSlotAckStatus.Registered), ws.data.hostId);
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
    const host = [...this.#hosts.values()].find((candidate) => candidate.data.registered?.slot === slot);
    if (host === undefined) return undefined;
    const registered = host.data.registered;
    const signPub = host.data.signPub;
    if (registered === undefined || signPub === undefined) return undefined;
    if (registered.slot !== slot || registered.signed === undefined) return undefined;
    return {
      hostId: host.data.hostId,
      noiseStaticPub: base64urlFor(registered.noiseStaticPub),
      signPub: base64urlFor(signPub),
      expiresAt: registered.signed.expiresAt,
      slotSig: base64urlFor(registered.signed.signature),
    };
  }
}

const base64urlFor = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
