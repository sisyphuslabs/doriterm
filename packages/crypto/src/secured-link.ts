import type { SessionKind } from "./kinds.ts";
import type { Stream } from "./payloads.ts";
import { type ByteLink, CloseCode, closeCodeOf, Listeners, SecureLinkError, type Unsubscribe } from "./link.ts";
import type { Transport } from "./transport.ts";

/** Unread plaintext a session holds for a listener before it closes with 4408 instead of buffering more. */
export const MAX_HELD_BYTES = 4 * 1024 * 1024;

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
 * The established session. Data that arrives before the first `onData` listener is held and handed to it, so no
 * byte is lost between the handshake resolving and the caller subscribing. Every chunk passes through that queue, so
 * a record that arrives while a listener runs is delivered after the chunks already waiting.
 */
export class SecuredLink implements SecureLink {
  readonly kind: SessionKind;
  readonly remoteStatic: Uint8Array;
  readonly handshakeHash: Uint8Array;
  readonly peerName: string | undefined;
  readonly lanUrls: readonly string[];
  readonly stream: Stream | undefined;
  readonly #link: ByteLink;
  readonly #transport: Transport;
  readonly #data = new Listeners<Uint8Array>();
  readonly #close = new Listeners<Error | undefined>();
  readonly #held: Uint8Array[] = [];
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
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) throw new SecureLinkError(undefined, "secure link is closed");
    for (const record of this.#transport.seal(bytes)) {
      if (this.#closed) return;
      this.#link.send(record);
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
    this.linkClosed(undefined);
    this.#link.close(code, reason);
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
    this.#enqueue(plaintext);
    this.#drain();
  }

  /** Records the failure first, so a link that reports its close synchronously cannot replace it. */
  fail(error: SecureLinkError): void {
    if (this.#closed) return;
    this.linkClosed(error);
    this.#link.close(error.code, error.message);
  }

  linkClosed(error: Error | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    const code = closeCodeOf(error);
    this.#closeError =
      error === undefined || error instanceof SecureLinkError
        ? error
        : new SecureLinkError(code, error.message, { cause: error });
    this.#held.length = 0;
    this.#heldBytes = 0;
    this.#close.emit(this.#closeError);
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
