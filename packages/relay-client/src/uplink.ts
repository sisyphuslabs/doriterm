import { redialDelay } from "./backoff.ts";
import { AckCounter, keepAlive } from "./flow-control.ts";
import { rethrowAfter } from "./inbox.ts";
import { LinkClosedError } from "./link.ts";
import { PairSlotMalformedError, type PairSlotResult, PairSlotRequests } from "./pair-requests.ts";
import type { RelayProofs } from "./pass-book.ts";
import { UplinkPasses } from "./uplink-passes.ts";
import { SessionLink } from "./session-link.ts";
import type { HostSigner } from "./signer.ts";
import { closeSocket, type CreateSocket, defaultCreateSocket, isOpen, relaySocketUrl } from "./socket.ts";
import {
  authMessage,
  CHALLENGE_BYTES,
  CloseCode,
  CREDIT_QUERY,
  decodeMux,
  encodeAuthAnswer,
  encodeClose,
  encodePairSlotClear,
  encodePairSlotRequest,
  pairSlotStatement,
  hostIdOf,
  MAX_ACTIVE_SESSIONS,
  MAX_PENDING_SESSIONS,
  MuxError,
  MuxType,
  PING_INTERVAL_MS,
  PONG,
  relayOriginOf,
} from "./wire/index.ts";

export type UplinkState =
  | { readonly state: "connecting"; readonly attempt: number }
  /** The challenge answer is sent; the relay closes with 4403 if it is wrong. */
  | { readonly state: "answered" }
  /** The uplink closed and redials; `reason` is the close frame's text, empty when the socket died without one. */
  | { readonly state: "waiting"; readonly code: number; readonly reason: string; readonly retryInMs: number }
  | { readonly state: "stopped"; readonly code: number };

/**
 * A session the uplink refused with CLOSE 4429 because a contract cap was full: an OPEN while 8 sessions wait for the
 * host's first DATA (`pending_cap`), or a first DATA while 32 sessions are active (`active_cap`). The host enforces the
 * caps so that a relay that ignores them cannot make it allocate sessions without bound.
 */
export interface SessionRefusal {
  readonly sessionId: number;
  readonly reason: "pending_cap" | "active_cap";
}

export interface UplinkOptions {
  /** e.g. `https://relay-doriface.omo.dev`. */
  readonly relayUrl: string;
  readonly signer: HostSigner;
  /** Called for every client session the relay opens; the link ends when the client leaves or the uplink drops. */
  readonly onSession: (session: SessionLink) => void;
  readonly onState?: (state: UplinkState) => void;
  /** Called for every session refused over the session caps; the refused session allocates nothing. */
  readonly onRefused?: (refusal: SessionRefusal) => void;
  /**
   * The relay refused this connection's signed PAIR_SLOT, so a slot went unsigned for that request (#22): told at most
   * once per connection. Clients of contract v1.9 refuse an unsigned slot, so this names an outdated relay.
   */
  readonly onUnsignedPairSlot?: (slot: string) => void;
  readonly createSocket?: CreateSocket;
  readonly random?: () => number;
  readonly pingIntervalMs?: number;
  /** Ask the relay for session credit (contract v1.4); default true. */
  readonly credit?: boolean;
  /** The host's relay passes (contract v1.6): with them the uplink asks for passes and presents proofs. */
  readonly proofs?: RelayProofs | undefined;
}

/** Reconnecting cannot fix these: the key is wrong, or another uplink for this host took over. */
const FINAL_CODES: ReadonlySet<number> = new Set([CloseCode.RelayAuthFailed, CloseCode.UplinkReplaced]);
const CONNECTING = 0;
/** How long a pair-slot request waits for the relay's reply; a host's stop waits this long to release its slot. */
export const PAIR_SLOT_REPLY_TIMEOUT_MS = 10_000;
/** An uplink that stayed up this long after answering redials at once, then backs off from the bottom again. */
const STABLE_MS = 30_000;

/** The host's one connection to the relay, carrying every client session multiplexed by sessionId. */
export class Uplink {
  readonly hostId: string;
  /** Resolves with the close code once the uplink stops for good: `stop()`, 4403 or 4409. */
  readonly stopped: Promise<number>;
  readonly #options: UplinkOptions;
  readonly #url: string;
  readonly #relayOrigin: string;
  readonly #sessions = new Map<number, SessionLink>();
  readonly #stop = Promise.withResolvers<number>();
  readonly #pairSlots = new PairSlotRequests();
  readonly #passes: UplinkPasses | undefined;
  #socket: WebSocket | undefined;
  #stopPings: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #answeredAt: number | undefined;
  #pairSlot: string | undefined;
  /** Whether this connection already told onUnsignedPairSlot. */
  #toldUnsigned = false;
  #pairSlotQueue: Promise<void> = Promise.resolve();
  #done = false;

  private constructor(hostId: string, options: UplinkOptions) {
    this.hostId = hostId;
    this.#options = options;
    const query = options.credit === false ? "" : `?${CREDIT_QUERY.join("=")}`;
    this.#url = relaySocketUrl(options.relayUrl, `/v1/host/${hostId}${query}`);
    this.#relayOrigin = relayOriginOf(this.#url);
    this.stopped = this.#stop.promise;
    const { proofs } = options;
    this.#passes =
      proofs === undefined
        ? undefined
        : new UplinkPasses(proofs, this.#relayOrigin, hostId, options.random ?? Math.random);
  }

  static async start(options: UplinkOptions): Promise<Uplink> {
    const uplink = new Uplink(await hostIdOf(options.signer.publicKey), options);
    uplink.#connect();
    return uplink;
  }

  /**
   * Registers a pairing slot (the typed code's first 3 characters) so a client with only the code can find this
   * host. "taken" means another host holds the slot: draw a new code. Rejects if the uplink is not connected.
   */
  registerPairSlot(slot: string, noiseStaticPub: Uint8Array, expiresAt: number): Promise<PairSlotResult> {
    return this.#onePairSlotRequest(async () => {
      const outcome = await this.#signedPairSlotRequest(slot, noiseStaticPub, expiresAt);
      if (outcome === "registered") this.#pairSlot = slot;
      return outcome;
    });
  }

  /**
   * Every registration is sent in the signed form of contract v1.9 first: the host's signature over its slot, Noise key
   * and the offer's expiry (#22). A relay older than v1.9 acks it Malformed; then this request alone is sent unsigned,
   * so the next registration tries the signed form again and a relay updated meanwhile gets it.
   */
  async #signedPairSlotRequest(slot: string, noiseStaticPub: Uint8Array, expiresAt: number): Promise<PairSlotResult> {
    const signature = await this.#options.signer.sign(pairSlotStatement(slot, noiseStaticPub, expiresAt));
    try {
      return await this.#pairSlotRequest(slot, encodePairSlotRequest(slot, noiseStaticPub, { expiresAt, signature }));
    } catch (error) {
      if (!(error instanceof PairSlotMalformedError)) throw error;
      if (!this.#toldUnsigned) {
        this.#toldUnsigned = true;
        this.#options.onUnsignedPairSlot?.(slot);
      }
      return this.#pairSlotRequest(slot, encodePairSlotRequest(slot, noiseStaticPub));
    }
  }

  /**
   * Releases the host's registered slot (an empty PAIR_SLOT), e.g. once pairing succeeded or expired. The relay keeps
   * the slot per host, so this works across reconnects; a new process passes `slot` from its own pairing state.
   */
  clearPairSlot(slot: string | undefined = this.#pairSlot): Promise<void> {
    return this.#onePairSlotRequest(async () => {
      if (slot === undefined) return;
      await this.#pairSlotRequest(slot, encodePairSlotClear());
      this.#pairSlot = undefined;
    });
  }

  /** Runs PAIR_SLOT operations one at a time, so each reply answers the request that is actually waiting. */
  #onePairSlotRequest<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pairSlotQueue.then(operation);
    this.#pairSlotQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #pairSlotRequest(slot: string, frame: Uint8Array<ArrayBuffer>): Promise<PairSlotResult> {
    const ws = this.#connected();
    const reply = this.#pairSlots.wait(slot, PAIR_SLOT_REPLY_TIMEOUT_MS);
    ws.send(frame);
    return reply;
  }

  #connected(): WebSocket {
    const ws = this.#socket;
    if (ws === undefined || !isOpen(ws) || this.#answeredAt === undefined) {
      throw new LinkClosedError("the uplink is not connected");
    }
    return ws;
  }

  /** Closes the uplink and every session on it, and stops reconnecting. */
  stop(): void {
    this.#finish(CloseCode.Normal);
  }

  #connect(): void {
    this.#timer = undefined;
    this.#answeredAt = undefined;
    this.#options.onState?.({ state: "connecting", attempt: this.#attempt });
    const url = this.#passes?.attemptUrl(this.#url) ?? this.#url;
    const ws = (this.#options.createSocket ?? defaultCreateSocket)(url);
    ws.binaryType = "arraybuffer";
    this.#socket = ws;
    this.#passes?.attempting(ws);
    let challenged = false;
    const acks = new AckCounter();
    const arrived = (bytes: number): void => {
      const ack = acks.ackFor(bytes);
      if (ack !== undefined && isOpen(ws)) ws.send(ack);
    };
    this.#stopPings = keepAlive(ws, this.#options.pingIntervalMs ?? PING_INTERVAL_MS);
    ws.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data === PONG) return;
      if (!(event.data instanceof ArrayBuffer))
        return closeSocket(ws, CloseCode.UnsupportedData, "binary messages only");
      const bytes = new Uint8Array(event.data);
      if (challenged) return this.#frame(ws, bytes, arrived);
      arrived(bytes.byteLength);
      challenged = true;
      this.#passes?.challenged();
      this.#answer(ws, bytes).catch(() => closeSocket(ws, CloseCode.InternalError, "signing failed"));
    });
    ws.addEventListener("close", (event: CloseEvent) => this.#lost(ws, event.code, event.reason));
  }

  async #answer(ws: WebSocket, challenge: Uint8Array): Promise<void> {
    if (challenge.byteLength !== CHALLENGE_BYTES) return closeSocket(ws, CloseCode.ProtocolError, "bad challenge");
    const { signer } = this.#options;
    const signature = await signer.sign(authMessage(this.#relayOrigin, this.hostId, challenge));
    if (!isOpen(ws)) return;
    ws.send(encodeAuthAnswer(signer.publicKey, signature));
    this.#answeredAt = Date.now();
    this.#toldUnsigned = false;
    this.#options.onState?.({ state: "answered" });
  }

  /** Handles one relay frame; every frame is acked on arrival, and each session bounds its own backlog. */
  #frame(ws: WebSocket, bytes: Uint8Array, arrived: (bytes: number) => void): void {
    let frame;
    try {
      frame = decodeMux(bytes);
    } catch (error) {
      if (error instanceof MuxError) return closeSocket(ws, CloseCode.ProtocolError, error.message);
      throw error;
    }
    arrived(bytes.byteLength);
    if (frame.type === MuxType.Pass) {
      if (this.#passes?.frame(frame.payload) !== true) closeSocket(ws, CloseCode.RelayProtocolError, "bad PASS");
      return;
    }
    const session = this.#sessions.get(frame.sessionId);
    if (frame.type === MuxType.Data && session !== undefined) return session.deliver(frame.payload);
    if (frame.type === MuxType.PairSlotAck) {
      if (!this.#pairSlots.settle(frame.payload)) closeSocket(ws, CloseCode.RelayProtocolError, "bad PAIR_SLOT_ACK");
      return;
    }
    if (frame.type === MuxType.PairSlot)
      return closeSocket(ws, CloseCode.RelayProtocolError, "PAIR_SLOT is host to relay");
    if (frame.type === MuxType.Data) return;
    if (frame.type === MuxType.Credit) {
      if (session !== undefined && !session.credited(frame.bytes))
        closeSocket(ws, CloseCode.RelayProtocolError, `credit for unsent bytes on session ${frame.sessionId}`);
      return;
    }
    if (frame.type === MuxType.Close) return session?.ended(frame.code);
    if (session !== undefined)
      return closeSocket(ws, CloseCode.ProtocolError, `session ${frame.sessionId} is already open`);
    if (this.#sessions.size - this.#active() >= MAX_PENDING_SESSIONS) {
      ws.send(encodeClose(frame.sessionId, CloseCode.RateLimited));
      return this.#options.onRefused?.({ sessionId: frame.sessionId, reason: "pending_cap" });
    }
    const link = new SessionLink(frame.sessionId, frame.pairSlot, {
      sendFrame: (out) => {
        if (!isOpen(ws)) return false;
        ws.send(out);
        return true;
      },
      release: (sessionId) => this.#sessions.delete(sessionId),
      answer: (sessionId) => {
        if (this.#active() < MAX_ACTIVE_SESSIONS) return true;
        this.#options.onRefused?.({ sessionId, reason: "active_cap" });
        return false;
      },
    });
    this.#sessions.set(frame.sessionId, link);
    this.#options.onSession(link);
  }

  /** Sessions the host has sent DATA on; the rest are pending (contract "Session admission"). */
  #active(): number {
    let active = 0;
    for (const session of this.#sessions.values()) if (session.answered) active += 1;
    return active;
  }

  #lost(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.#socket) return;
    this.#socket = undefined;
    this.#pairSlots.failAll(`the uplink closed with ${code} before the relay answered`);
    if (FINAL_CODES.has(code)) return this.#finish(code);
    const stable = this.#answeredAt !== undefined && Date.now() - this.#answeredAt >= STABLE_MS;
    if (stable) this.#attempt = 0;
    const retryInMs = this.#passes?.reconnectDelay(code) ?? redialDelay(stable, this.#attempt, this.#options.random);
    if (!stable) this.#attempt += 1;
    this.#options.onState?.({ state: "waiting", code, reason, retryInMs });
    this.#timer = setTimeout(() => this.#connect(), retryInMs);
    // Last, so a session's throwing close listener cannot cancel the reconnect.
    this.#endSessions(code);
  }

  #endSessions(code: number): void {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    const sessionCode = code === CloseCode.Normal ? CloseCode.GoingAway : code;
    rethrowAfter(sessions.map((session) => () => session.ended(sessionCode)));
  }

  #finish(code: number): void {
    if (this.#done) return;
    this.#done = true;
    clearTimeout(this.#timer);
    this.#passes?.stop();
    const ws = this.#socket;
    this.#socket = undefined;
    this.#stopPings?.();
    this.#pairSlots.failAll("the uplink stopped");
    // A socket still connecting is closed too; otherwise it could authenticate after the stop.
    if (ws !== undefined && (ws.readyState === CONNECTING || isOpen(ws))) ws.close(CloseCode.Normal, "host stopping");
    this.#options.onState?.({ state: "stopped", code });
    this.#stop.resolve(code);
    this.#endSessions(code);
  }
}
