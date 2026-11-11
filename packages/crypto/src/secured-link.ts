import type { SessionKind } from "./kinds.ts";
import type { Stream } from "./payloads.ts";
import { type ByteLink, CloseCode, closeCodeOf, Listeners, SecureLinkError, type Unsubscribe } from "./link.ts";
import { RecordRing } from "./record-ring.ts";
import { type RecordCounters, resumeKeys, type ResumeKeys } from "./resume.ts";
import { acceptResume, type ResumableSession, resumeOn } from "./session-resume.ts";
import type { Transport } from "./transport.ts";

/** Unread plaintext a session holds for a listener before it closes with 4408 instead of buffering more. */
export const MAX_HELD_BYTES = 4 * 1024 * 1024;
/** The WebSocket normal close: how a link a session has left is let go. */
const NORMAL_CLOSE = 1000;
/** WebSocket 1001: the peer said it is going away (a host shutting down), so its close is meant, not a drop. */
const GOING_AWAY = 1001;
const goingAway = (error: Error): boolean => closeCodeOf(error) === GOING_AWAY;

export interface SessionInfo {
  readonly kind: SessionKind;
  readonly remoteStatic: Uint8Array;
  readonly handshakeHash: Uint8Array;
  /** Responder, pairing sessions: the device name from message 1. */
  readonly peerName: string | undefined;
  /** Initiator: the host's LAN URLs from message 2 (IP literals). */
  readonly lanUrls: readonly string[];
  /** What the plaintext carries: absent (the hc stream, or a device pairing), `"hc"` or `"mesh"`. */
  readonly stream: Stream | undefined;
}

/** A ByteLink whose bytes travel as Noise transport records over another ByteLink. */
export interface SecureLink extends ByteLink, SessionInfo {}

/**
 * The session `secureLink` establishes, which outlives the link it runs on (contract v1.11 "Session resume"): once
 * `allowResume` was called, a link that drops detaches the session instead of closing it, and `resume` (the initiator)
 * or `accept` (the responder) carries it on over a new link.
 */
export interface SecureSession extends SecureLink {
  readonly closed: boolean;
  /** The link the records travel over now; undefined while detached. */
  readonly link: ByteLink | undefined;
  readonly detached: boolean;
  /** Records sent and opened so far: the position a resume carries. */
  readonly counters: RecordCounters;
  readonly resumeKeys: ResumeKeys;
  /** From now on a link that drops detaches the session for a resume; without this call it closes it, as before. */
  allowResume(): void;
  onDetached(listener: (reason: Error) => void): Unsubscribe;
  /** Runs `listener` with each new link the session is carried on over, right after it is bound. */
  onLink(listener: (link: ByteLink) => void): Unsubscribe;
  /** Resolves once a link carries the session, at once while one does. */
  attached(): Promise<void>;
  /** The link under the session is gone or silent: detaches when a resume is allowed and reports whether it did. */
  lost(reason: Error): boolean;
  /** Ends the session as failed with `reason` (a resume that could not be made), closing any link it still has. */
  abandon(reason: Error): void;
  /**
   * Initiator: carries the detached session on over `link`, a fresh socket to the same host. Rejects, with the link
   * closed and the session still detached, when the host refuses, answers wrongly or does not answer within `timeoutMs`.
   */
  resume(link: ByteLink, timeoutMs?: number): Promise<void>;
  /**
   * Responder: answers `request` (the first message on `link`, `pending` what followed it) and carries the session on
   * over `link`; false refuses it and leaves the session as it was.
   */
  accept(link: ByteLink, request: Uint8Array, pending?: readonly Uint8Array[]): boolean;
}

/**
 * The established session. Data that arrives before the first `onData` listener is held and handed to it, so no
 * byte is lost between the handshake resolving and the caller subscribing. Every chunk passes through that queue, so
 * a record that arrives while a listener runs is delivered after the chunks already waiting.
 */
export class SecuredLink implements SecureSession, ResumableSession {
  readonly kind: SessionKind;
  readonly remoteStatic: Uint8Array;
  readonly handshakeHash: Uint8Array;
  readonly peerName: string | undefined;
  readonly lanUrls: readonly string[];
  readonly stream: Stream | undefined;
  readonly resumeKeys: ResumeKeys;
  readonly #transport: Transport;
  readonly #data = new Listeners<Uint8Array>();
  readonly #close = new Listeners<Error | undefined>();
  readonly #detach = new Listeners<Error>();
  readonly #links = new Listeners<ByteLink>();
  readonly #ring = new RecordRing();
  readonly #held: Uint8Array[] = [];
  #link: ByteLink | undefined;
  /** Listeners on a link this session bound itself (a resumed one); the handshake link's are the handshake's own. */
  #bound: readonly Unsubscribe[] = [];
  #attached: PromiseWithResolvers<void> | undefined;
  #resumable = false;
  #sent = 0;
  /** `#sent` when the session last detached: records numbered from here on were never on a link the peer read. */
  #detachedAt = 0;
  #received = 0;
  #heldBytes = 0;
  #draining = false;
  #closed = false;
  #closeError: Error | undefined;

  constructor(link: ByteLink, transport: Transport, info: SessionInfo) {
    this.#link = link;
    this.#transport = transport;
    this.kind = info.kind;
    this.remoteStatic = info.remoteStatic;
    this.handshakeHash = info.handshakeHash;
    this.peerName = info.peerName;
    this.lanUrls = info.lanUrls;
    this.stream = info.stream;
    this.resumeKeys = resumeKeys(info.handshakeHash);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get link(): ByteLink | undefined {
    return this.#link;
  }

  get detached(): boolean {
    return !this.#closed && this.#link === undefined;
  }

  get counters(): RecordCounters {
    return { sent: this.#sent, received: this.#received };
  }

  allowResume(): void {
    this.#resumable = true;
  }

  onDetached(listener: (reason: Error) => void): Unsubscribe {
    return this.#detach.add(listener);
  }

  onLink(listener: (link: ByteLink) => void): Unsubscribe {
    return this.#links.add(listener);
  }

  attached(): Promise<void> {
    if (this.#link !== undefined || this.#closed) return Promise.resolve();
    this.#attached ??= Promise.withResolvers<void>();
    return this.#attached.promise;
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) throw new SecureLinkError(undefined, "secure link is closed");
    for (const record of this.#transport.seal(bytes)) {
      if (this.#closed) return;
      this.#ring.push(record);
      this.#sent += 1;
      // A record sent while detached is gone from the ring: the peer can never have opened it, so the session cannot be
      // resumed exactly and does not wait to be. Older records leaving the ring decide nothing here; the peer most likely
      // opened them, and the resume exchange checks its position against what the ring still holds.
      if (this.#link === undefined && this.#ring.first > this.#detachedAt) {
        return this.fail(new SecureLinkError(CloseCode.IdleTimeout, "too much data while detached"));
      }
      this.#link?.send(record);
    }
  }

  onData(listener: (bytes: Uint8Array) => void): Unsubscribe {
    const unsubscribe = this.#data.add(listener);
    this.#drain();
    return unsubscribe;
  }

  onClose(listener: (error: Error | undefined) => void): Unsubscribe {
    if (!this.#closed) return this.#close.add(listener);
    const error = this.#closeError;
    let active = true;
    queueMicrotask(() => {
      if (active) listener(error);
    });
    return () => {
      active = false;
    };
  }

  close(code?: number, reason?: string): void {
    if (this.#closed) return;
    const link = this.#link;
    this.#end(undefined);
    link?.close(code, reason);
  }

  /** Hands bytes that arrived inside the handshake (IK early data) to the first data listener. */
  hold(bytes: Uint8Array): void {
    this.#enqueue(bytes);
  }

  /** Feeds one record from the underlying link; any failure closes the link with 4400. */
  receive(record: Uint8Array): void {
    if (this.#closed) return;
    let plaintext: Uint8Array;
    try {
      plaintext = this.#transport.open(record);
    } catch (error) {
      this.fail(new SecureLinkError(CloseCode.CryptoFailure, "record failed authentication", { cause: error }));
      return;
    }
    this.#received += 1;
    this.#enqueue(plaintext);
    this.#drain();
  }

  /** Records the failure first, so a link that reports its close synchronously cannot replace it. */
  fail(error: SecureLinkError): void {
    if (this.#closed) return;
    const link = this.#link;
    this.#end(error);
    link?.close(error.code, error.message);
  }

  /**
   * The link under the session closed with `error` (undefined: a normal close). A link other than the current one is a
   * former one, whose late close means nothing. A link that failed while a resume is allowed detaches the session; a
   * close the peer meant ends it: a normal one, or going away, which a host sends as it shuts down.
   */
  linkClosed(error: Error | undefined, link?: ByteLink): void {
    if (this.#closed) return;
    if (link !== undefined && link !== this.#link) return;
    if (error !== undefined && !goingAway(error) && this.#resumable && this.#link !== undefined) {
      return this.#detachFor(error);
    }
    this.#end(error);
  }

  #end(error: Error | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    const code = closeCodeOf(error);
    this.#closeError =
      error === undefined || error instanceof SecureLinkError
        ? error
        : new SecureLinkError(code, error.message, { cause: error });
    this.#unbind();
    this.#link = undefined;
    this.#attached?.resolve();
    this.#held.length = 0;
    this.#heldBytes = 0;
    this.#close.emit(this.#closeError);
  }

  abandon(reason: Error): void {
    if (this.#closed) return;
    const link = this.#link;
    this.#end(reason);
    link?.close(closeCodeOf(reason) ?? CloseCode.IdleTimeout, reason.message);
  }

  lost(reason: Error): boolean {
    if (this.#closed || !this.#resumable) return false;
    const link = this.#link;
    if (link === undefined) return true;
    this.#detachFor(reason);
    link.close(CloseCode.IdleTimeout, reason.message);
    return true;
  }

  resume(link: ByteLink, timeoutMs?: number): Promise<void> {
    return resumeOn(this, link, timeoutMs);
  }

  accept(link: ByteLink, request: Uint8Array, pending: readonly Uint8Array[] = []): boolean {
    return acceptResume(this, link, request, pending);
  }

  replayFrom(sequence: number): readonly Uint8Array[] | undefined {
    return this.#ring.from(sequence);
  }

  /**
   * Carries the session on over `link`: what arrived on it before this session listened is opened first, then its
   * records come here as they arrive, and its close is this session's to judge. A former link still open is closed.
   */
  rebind(link: ByteLink, pending: readonly Uint8Array[] = []): void {
    const former = this.#link;
    this.#unbind();
    this.#link = link;
    for (const record of pending) this.receive(record);
    this.#bound = [
      link.onData((record) => this.receive(record)),
      link.onClose((error) => this.linkClosed(error, link)),
    ];
    former?.close(NORMAL_CLOSE, "resumed on another link");
    this.#links.emit(link);
    this.#attached?.resolve();
    this.#attached = undefined;
  }

  #detachFor(reason: Error): void {
    this.#unbind();
    this.#link = undefined;
    this.#detachedAt = this.#sent;
    this.#detach.emit(reason);
  }

  #unbind(): void {
    for (const unsubscribe of this.#bound) unsubscribe();
    this.#bound = [];
  }

  #enqueue(bytes: Uint8Array): void {
    if (this.#closed || bytes.byteLength === 0) return;
    this.#held.push(bytes);
    this.#heldBytes += bytes.byteLength;
    if (this.#heldBytes > MAX_HELD_BYTES) this.fail(new SecureLinkError(CloseCode.IdleTimeout, "too much unread data"));
  }

  /** Emits held chunks in order; a listener that closes the link stops the rest. */
  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#closed && this.#data.size > 0) {
        const chunk = this.#held.shift();
        if (chunk === undefined) break;
        this.#heldBytes -= chunk.byteLength;
        this.#data.emit(chunk);
      }
    } finally {
      this.#draining = false;
    }
  }
}
