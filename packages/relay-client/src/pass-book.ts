import { ed25519 } from "@noble/curves/ed25519.js";
import type { Unsubscribe } from "./link.ts";
import { toBase64Url } from "./wire/base64url.ts";
import { encodeProof, passFields, type PassFrame, proofMessage, type ProofRole } from "./wire/pass.ts";

/** A pass as the host keeps it: the bytes, the relay's clock offset when it arrived, and when that was (local ms). */
export interface StoredPass {
  readonly pass: Uint8Array<ArrayBuffer>;
  readonly offsetMs: number;
  readonly receivedAt: number;
}

/** Where passes live between runs, keyed by relay origin; `save` must replace the whole store atomically. */
export interface PassStore {
  load(): ReadonlyMap<string, StoredPass>;
  save(passes: ReadonlyMap<string, StoredPass>): void;
}

/** What the uplink and the dialers need from a host's passes (contract v1.6). */
export interface RelayProofs {
  /** A proof for one upgrade, or undefined to dial without one. */
  proof(role: ProofRole, target: string, relayOrigin: string): string | undefined;
  /** A PASS frame from this relay on the host's uplink. */
  received(relayOrigin: string, frame: PassFrame): void;
  /** The relay refused a proof (4412). */
  refused(relayOrigin: string): void;
  /** The relay forwarded a proven upgrade (its challenge arrived). */
  accepted(relayOrigin: string): void;
  /** Whether the host should ask this relay for a pass now. */
  wantsPass(relayOrigin: string): boolean;
  /** Called when a pass request should go out now (no usable pass any more). */
  onWant(listener: (relayOrigin: string) => void): Unsubscribe;
  onPass(listener: (relayOrigin: string) => void): Unsubscribe;
}

export const PASS_LIMITS = {
  /** A pass this close to its expiry (relay clock) is not presented. */
  expiryMarginMs: 60_000,
  /** A pass older than this is refreshed. */
  refreshAgeMs: 24 * 60 * 60_000,
  /** Consecutive refusals that stop proofs to a relay for `cooldownMs` (a relay-side fault). */
  refusalLimit: 3,
  cooldownMs: 10 * 60_000,
} as const;

interface Entry extends StoredPass {
  readonly usable: boolean;
}

export interface PassBookOptions {
  readonly secretKey: Uint8Array;
  readonly store: PassStore;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** A host's relay passes: validates what relays send, keeps the newest per relay, and builds proofs from them. */
export class PassBook implements RelayProofs {
  readonly #secretKey: Uint8Array;
  readonly #signPub: Uint8Array;
  readonly #hostIdHash: Uint8Array;
  readonly #store: PassStore;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #entries: Map<string, Entry>;
  readonly #refusals = new Map<string, number>();
  readonly #cooldownUntil = new Map<string, number>();
  readonly #wantListeners = new Set<(relayOrigin: string) => void>();
  readonly #passListeners = new Set<(relayOrigin: string) => void>();

  private constructor(options: PassBookOptions, hostIdHash: Uint8Array) {
    this.#secretKey = options.secretKey.slice();
    this.#signPub = ed25519.getPublicKey(this.#secretKey);
    this.#hostIdHash = hostIdHash;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => undefined);
    this.#entries = new Map([...options.store.load()].map(([origin, stored]) => [origin, { ...stored, usable: true }]));
  }

  static async create(options: PassBookOptions): Promise<PassBook> {
    const signPub = ed25519.getPublicKey(options.secretKey);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signPub));
    return new PassBook(options, digest.slice(0, 16));
  }

  proof(role: ProofRole, target: string, relayOrigin: string): string | undefined {
    const now = this.#now();
    if ((this.#cooldownUntil.get(relayOrigin) ?? 0) > now) return undefined;
    const entry = this.#entries.get(relayOrigin);
    const fields = entry === undefined ? undefined : passFields(entry.pass);
    if (entry === undefined || !entry.usable || fields === undefined) return undefined;
    const ts = now + entry.offsetMs;
    if (fields.expiresAt * 1000 - ts < PASS_LIMITS.expiryMarginMs) return undefined;
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const { body, message } = proofMessage({
      pass: entry.pass,
      signPub: this.#signPub,
      relayOrigin,
      role,
      target,
      ts,
      nonce,
    });
    return toBase64Url(encodeProof(body, ed25519.sign(message, this.#secretKey)));
  }

  received(relayOrigin: string, frame: PassFrame): void {
    const fields = frame.pass === undefined ? undefined : passFields(frame.pass);
    const ours = fields !== undefined && fields.hostIdHash.every((byte, index) => byte === this.#hostIdHash[index]);
    if (frame.pass === undefined || fields === undefined || !ours || fields.expiresAt * 1000 <= frame.relayNowMs)
      return;
    const now = this.#now();
    this.#entries.set(relayOrigin, {
      pass: frame.pass,
      offsetMs: frame.relayNowMs - now,
      receivedAt: now,
      usable: true,
    });
    const kept = [...this.#entries].filter(([, entry]) => entry.usable);
    this.#store.save(
      new Map(kept.map(([origin, { pass, offsetMs, receivedAt }]) => [origin, { pass, offsetMs, receivedAt }])),
    );
    for (const listener of this.#passListeners) listener(relayOrigin);
  }

  refused(relayOrigin: string): void {
    const entry = this.#entries.get(relayOrigin);
    // Several dials in flight on one dead pass are one refusal: only the first refusal of a usable pass counts.
    if (entry === undefined || !entry.usable) return;
    this.#entries.set(relayOrigin, { ...entry, usable: false });
    const refusals = (this.#refusals.get(relayOrigin) ?? 0) + 1;
    if (refusals >= PASS_LIMITS.refusalLimit) {
      this.#cooldownUntil.set(relayOrigin, this.#now() + PASS_LIMITS.cooldownMs);
      this.#refusals.delete(relayOrigin);
      this.#log(`relay refuses this host's passes; using the address path for 10 minutes (${relayOrigin})`);
    } else this.#refusals.set(relayOrigin, refusals);
    for (const listener of this.#wantListeners) listener(relayOrigin);
  }

  accepted(relayOrigin: string): void {
    this.#refusals.delete(relayOrigin);
  }

  wantsPass(relayOrigin: string): boolean {
    const entry = this.#entries.get(relayOrigin);
    return entry === undefined || !entry.usable || this.#now() - entry.receivedAt > PASS_LIMITS.refreshAgeMs;
  }

  onWant(listener: (relayOrigin: string) => void): Unsubscribe {
    this.#wantListeners.add(listener);
    return () => this.#wantListeners.delete(listener);
  }

  onPass(listener: (relayOrigin: string) => void): Unsubscribe {
    this.#passListeners.add(listener);
    return () => this.#passListeners.delete(listener);
  }
}
