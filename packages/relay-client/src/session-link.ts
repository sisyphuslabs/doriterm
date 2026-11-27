import { CloseSignal, Inbox } from "./inbox.ts";
import {
  type ByteLink,
  type CloseListener,
  type DataListener,
  LinkClosedError,
  RelayCloseError,
  type Unsubscribe,
} from "./link.ts";
import { MAX_SESSION_SEND_BYTES } from "./limits.ts";
import { SendWindow } from "./send-window.ts";
import {
  ACK_INTERVAL_BYTES,
  CloseCode,
  encodeClose,
  encodeCredit,
  encodeData,
  MAX_UNACKED_BYTES,
} from "./wire/index.ts";

/** What a session needs from the uplink socket it is multiplexed over. */
export interface SessionTransport {
  /** False when the uplink socket can no longer carry the frame. */
  sendFrame(frame: Uint8Array<ArrayBuffer>): boolean;
  release(sessionId: number): void;
  /** Whether this pending session may become active: false once the host's active-session cap is full. */
  answer(sessionId: number): boolean;
}

/**
 * One client session as the host sees it: DATA frames on the uplink, demultiplexed by sessionId. The uplink acks every
 * frame on arrival (contract v1.3.1); this session bounds its own undelivered bytes instead, and once the relay grants
 * credit (v1.4) it reports what its reader took, so a client that honours credit never gets near that bound.
 */
export class SessionLink implements ByteLink {
  readonly sessionId: number;
  /** The slot of an IKpsk2 pairing session (the client dialed `?pair=<slot>`); undefined for an ordinary session. */
  readonly pairSlot: string | undefined;
  readonly restore: boolean;
  readonly #transport: SessionTransport;
  readonly #inbox: Inbox;
  readonly #closed = new CloseSignal();
  readonly #window = new SendWindow();
  #backlog = 0;
  #creditFlows = false;
  #uncredited = 0;
  #answered = false;

  constructor(sessionId: number, pairSlot: string | undefined, transport: SessionTransport, restore = false) {
    this.sessionId = sessionId;
    this.pairSlot = pairSlot;
    this.restore = restore;
    this.#transport = transport;
    this.#inbox = new Inbox(
      (error) => this.#end(error instanceof Error ? error : new Error(String(error)), true),
      (chunk) => this.#taken(chunk.byteLength),
    );
  }

  /** True once the host has sent DATA on this session: it is active, not pending (contract "Session admission"). */
  get answered(): boolean {
    return this.#answered;
  }

  send(bytes: Uint8Array): Promise<void> {
    if (this.#closed.fired) return Promise.reject(new LinkClosedError(`session ${this.sessionId} is closed`));
    if (bytes.byteLength > MAX_SESSION_SEND_BYTES) {
      const cap = `the relay's ${MAX_SESSION_SEND_BYTES}-byte message cap`;
      return Promise.reject(new RangeError(`${bytes.byteLength} bytes exceed ${cap}`));
    }
    if (!this.#answered) {
      if (!this.#transport.answer(this.sessionId)) {
        const refused = new RelayCloseError(CloseCode.RateLimited, "the host's active session cap is full");
        this.#end(refused, true, CloseCode.RateLimited);
        return Promise.reject(refused);
      }
      this.#answered = true;
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const go = (): void => {
      if (this.#transport.sendFrame(encodeData(this.sessionId, bytes))) resolve();
      else reject(new LinkClosedError(`the uplink carrying session ${this.sessionId} is closed`));
    };
    this.#window.admit(bytes.byteLength, go, reject);
    return promise;
  }

  /** Called by the uplink with each CREDIT for this session; false when it credits bytes never sent. */
  credited(bytes: number): boolean {
    this.#creditFlows = true;
    this.#reportCredit();
    return this.#window.credit(bytes);
  }

  onData(listener: DataListener): Unsubscribe {
    return this.#inbox.add(listener);
  }

  onClose(listener: CloseListener): Unsubscribe {
    return this.#closed.add(listener);
  }

  /**
   * Ends the session and tells the client, through the relay, with `code` (a normal close by default). The relay
   * passes on the codes a WebSocket endpoint may send and reports any other as a normal close.
   */
  close(code: number = CloseCode.Normal, reason = ""): void {
    this.#end(code === CloseCode.Normal ? undefined : new RelayCloseError(code, reason), true, code);
  }

  /** Called by the uplink with each DATA payload for this session. */
  deliver(payload: Uint8Array): void {
    if (this.#closed.fired) return;
    this.#backlog += payload.byteLength;
    if (this.#backlog > MAX_UNACKED_BYTES) return this.close(CloseCode.IdleTimeout, "session too far behind");
    this.#inbox.push(payload);
  }

  /** The client left (CLOSE from the relay) or the uplink dropped; nothing is sent back. */
  ended(code: number): void {
    this.#end(code === CloseCode.Normal ? undefined : new RelayCloseError(code, "session ended"), false);
  }

  #taken(bytes: number): void {
    this.#backlog -= bytes;
    this.#uncredited += bytes;
    this.#reportCredit();
  }

  #reportCredit(): void {
    if (!this.#creditFlows || this.#closed.fired || this.#uncredited < ACK_INTERVAL_BYTES) return;
    this.#transport.sendFrame(encodeCredit(this.sessionId, this.#uncredited));
    this.#uncredited = 0;
  }

  #end(error: Error | undefined, tellRelay: boolean, code?: number): void {
    if (this.#closed.fired) return;
    if (tellRelay) {
      const sent = code ?? (error === undefined ? CloseCode.Normal : CloseCode.InternalError);
      this.#transport.sendFrame(encodeClose(this.sessionId, sent));
    }
    this.#transport.release(this.sessionId);
    this.#inbox.clear();
    this.#window.drop(new LinkClosedError(`session ${this.sessionId} is closed`));
    this.#closed.fire(error);
  }
}
