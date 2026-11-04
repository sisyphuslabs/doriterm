import type { Unsubscribe } from "./link.ts";
import type { RelayProofs } from "./pass-book.ts";
import { isOpen } from "./socket.ts";
import { CloseCode, decodePassPayload, encodePassRequest, PASS_QUERY, PROOF_QUERY } from "./wire/index.ts";

/** Pass requests repeat this often while the host has none: strictly above the relay's 60 s pacing. */
const RETRY_MIN_MS = 65_000;
const RETRY_JITTER_MS = 10_000;
/** A 4429 on an attempt without a proof waits 30-60 s: brand-new co-located hosts share the address window. */
const REGISTRATION_MIN_MS = 30_000;
const REGISTRATION_JITTER_MS = 30_000;

/**
 * The uplink's side of relay passes (contract v1.6): it asks for passes with `?pass=1`, presents a proof on each
 * attempt, hands PASS frames to the host's `RelayProofs`, and sends pass requests only once this uplink has had a
 * PASS frame, so a relay that serves none never sees one.
 */
export class UplinkPasses {
  readonly #proofs: RelayProofs;
  readonly #relayOrigin: string;
  readonly #hostId: string;
  readonly #random: () => number;
  readonly #stopWant: Unsubscribe;
  #socket: WebSocket | undefined;
  #served = false;
  #deferred = false;
  #proven = false;
  #retry: ReturnType<typeof setTimeout> | undefined;

  constructor(proofs: RelayProofs, relayOrigin: string, hostId: string, random: () => number) {
    this.#proofs = proofs;
    this.#relayOrigin = relayOrigin;
    this.#hostId = hostId;
    this.#random = random;
    this.#stopWant = proofs.onWant((origin) => {
      if (origin === relayOrigin) this.request();
    });
  }

  /** The URL for the next attempt: `?pass=1`, plus a proof when the host holds a usable pass. */
  attemptUrl(base: string): string {
    const url = new URL(base);
    url.searchParams.set(...PASS_QUERY);
    const proof = this.#proofs.proof("host", this.#hostId, this.#relayOrigin);
    this.#proven = proof !== undefined;
    if (proof !== undefined) url.searchParams.set(PROOF_QUERY, proof);
    return url.toString();
  }

  /** A new attempt's socket: nothing is served on it yet. */
  attempting(socket: WebSocket): void {
    this.#socket = socket;
    this.#served = false;
    clearTimeout(this.#retry);
  }

  /** The relay's challenge arrived: a proof on this attempt was accepted. */
  challenged(): void {
    if (this.#proven) this.#proofs.accepted(this.#relayOrigin);
  }

  /** A PASS frame's payload; false when it is malformed (the caller closes the uplink). */
  frame(payload: Uint8Array): boolean {
    const decoded = decodePassPayload(payload);
    if (decoded === undefined) return false;
    this.#served = true;
    this.#proofs.received(this.#relayOrigin, decoded);
    this.#schedule(this.#deferred ? 0 : this.#jittered());
    this.#deferred = false;
    return true;
  }

  /** Asks the relay for a pass now, or as soon as this uplink has had a PASS frame. */
  request(): void {
    if (!this.#served) {
      this.#deferred = true;
      return;
    }
    this.#schedule(0);
  }

  /** The delay before reconnecting after `code`, or undefined to use the usual backoff. */
  reconnectDelay(code: number): number | undefined {
    // A 4412 on an attempt without a proof is no pass refusal (only a faulty stand-in sends one): the usual backoff.
    if (code === CloseCode.PassRefused && this.#proven) {
      this.#proofs.refused(this.#relayOrigin);
      return 0;
    }
    if (code === CloseCode.RateLimited && !this.#proven) {
      return REGISTRATION_MIN_MS + Math.round(this.#random() * REGISTRATION_JITTER_MS);
    }
    return undefined;
  }

  stop(): void {
    clearTimeout(this.#retry);
    this.#stopWant();
  }

  #jittered(): number {
    return RETRY_MIN_MS + Math.round(this.#random() * RETRY_JITTER_MS);
  }

  /** One check per uplink: it sends a request when the host wants a pass (none, refused or old), then checks again. */
  #schedule(delayMs: number): void {
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      const socket = this.#socket;
      if (!this.#served || socket === undefined || !isOpen(socket)) return;
      if (delayMs === 0 || this.#proofs.wantsPass(this.#relayOrigin)) socket.send(encodePassRequest());
      this.#schedule(this.#jittered());
    }, delayMs);
  }
}
