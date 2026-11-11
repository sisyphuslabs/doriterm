import {
  base64urlDecode,
  base64urlEncode,
  CloseCode,
  createPairingOffer,
  type HostPairingSecret,
  PAIRING_CODE_ATTEMPTS,
  type PairingOffer,
  PairingGuard,
  pairingSlotOf,
} from "@doriface/crypto";
import { join } from "node:path";
import { ensureStateDir, isRecord, readJson, removeFile, stringField, writePrivateJson } from "./files.ts";
import { DEFAULT_LOCK_TIMEOUT_MS, withStateLock } from "./lock.ts";

const FILE = "pairing.json";
const VERSION = 3;

/** Where the typed code's relay slot stands: `pending` until the running host's uplink answers. */
export type SlotStatus = "pending" | "registered" | "unavailable";

export interface PendingPairing extends PairingOffer {
  readonly slot: SlotStatus;
  /** Typed-code attempts the host has answered for this offer; at {@link PAIRING_CODE_ATTEMPTS} the code is retired. */
  readonly codeAttempts: number;
  /** A mesh offer admits a machine into the mesh (a join); otherwise it pairs a device (contract v1.5). */
  readonly mesh: boolean;
}

export const codeRetired = (pending: PendingPairing): boolean => pending.codeAttempts >= PAIRING_CODE_ATTEMPTS;

/** The offer as the control socket carries it: JSON, with the link secret in base64url. */
export const pendingToWire = (pending: PendingPairing) => ({
  code: pending.code,
  linkSecret: base64urlEncode(pending.linkSecret),
  expiresAt: pending.expiresAt,
  slot: pending.slot,
  codeAttempts: pending.codeAttempts,
  mesh: pending.mesh,
});

export function pendingFromWire(value: unknown): PendingPairing {
  if (!isRecord(value)) throw new Error("the running host sent a malformed pairing");
  const { code, linkSecret, expiresAt, slot, codeAttempts, mesh } = value;
  const knownSlot = slot === "pending" || slot === "registered" || slot === "unavailable";
  if (
    typeof code !== "string" ||
    typeof linkSecret !== "string" ||
    typeof expiresAt !== "number" ||
    typeof codeAttempts !== "number" ||
    (mesh !== undefined && typeof mesh !== "boolean") ||
    !knownSlot
  ) {
    throw new Error("the running host sent a malformed pairing");
  }
  return { code, linkSecret: base64urlDecode(linkSecret), expiresAt, slot, codeAttempts, mesh: mesh === true };
}

/** A claim on the live offer: the secret the handshake finishes with, and the step that burns the offer on success. */
export interface PairingClaim {
  readonly secret: HostPairingSecret;
  /** This claim's reservation used the code's last attempt; the code is retired from now on. */
  readonly retiredCode: boolean;
  /**
   * The handshake completed: burns the whole offer (code and link secret) and returns whether this was its first
   * success before expiry. It runs before the caller stores the device, so a crash or a failed store can never leave
   * the offer usable.
   */
  complete(now?: number): boolean;
}

export type ClaimRefusal = { readonly refused: number; readonly reason: string };

/**
 * Why a join on a device offer is refused: the one refusal of a typed-code join that keeps 4401, so the joiner pairs as a
 * device with the same code instead (#1492, `accept.ts`).
 */
export const JOIN_ON_DEVICE_OFFER = "a machine join on a device pairing offer";

/** A device pairing on a mesh offer, or a join on a device offer: refused before any answer, and not counted. */
const kindRefusal = (mesh: boolean): ClaimRefusal => ({
  refused: CloseCode.UnknownDevice,
  reason: mesh ? JOIN_ON_DEVICE_OFFER : "a device pairing on a mesh offer",
});

/**
 * The one pending pairing offer (pairing.json, 0600). `doriface-host pair` writes it, replacing any earlier one; the
 * running host claims it per pairing handshake, registers its relay slot, and deletes it once used or expired. Every
 * read-modify-write runs under the state lock, so a typed-code reservation and a new `pair` never overwrite each other.
 */
export class PairingStore {
  readonly #dir: string;
  readonly #path: string;
  readonly #log: (line: string) => void;
  readonly #lockTimeoutMs: number;
  #guard: PairingGuard | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(
    stateDir: string,
    log: (line: string) => void = () => {},
    options: { readonly lockTimeoutMs?: number } = {},
  ) {
    this.#dir = ensureStateDir(stateDir);
    this.#path = join(this.#dir, FILE);
    this.#log = log;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  offer(now = Date.now(), mesh = false): PendingPairing {
    const pending = { ...createPairingOffer(now), slot: "pending" as const, codeAttempts: 0, mesh };
    this.#locked(() => this.#write(pending));
    return pending;
  }

  /** Replaces the code of the pending offer after a relay slot collision; keeps its expiry, link secret and count. */
  redraw(code: string): PendingPairing | undefined {
    return this.#locked(() => {
      const current = this.read();
      if (current === undefined || current.code !== code) return current;
      const next = { ...current, code: createPairingOffer().code, slot: "pending" as const };
      this.#write(next);
      return next;
    });
  }

  setSlot(code: string, slot: SlotStatus): void {
    this.#locked(() => {
      const current = this.read();
      if (current?.code === code && current.slot !== slot) this.#write({ ...current, slot });
    });
  }

  /**
   * Reserves one typed-code attempt on the session's relay slot, durably, before the host answers it: re-reads the
   * offer under the lock, requires it live, on `openSlot` and not retired, then writes the incremented count. A
   * failed write throws, so the caller answers nothing.
   */
  claimCode(openSlot: string, now = Date.now(), mesh = false): PairingClaim | ClaimRefusal {
    return this.#locked(() => {
      const pending = this.#live(now, (expired) => this.#removeIfHeld(expired));
      if ("refused" in pending) return pending;
      if (pending.mesh !== mesh) return kindRefusal(mesh);
      if (pairingSlotOf(pending.code) !== openSlot) {
        return { refused: CloseCode.UnknownDevice, reason: "the session's slot is not the offer's" };
      }
      if (codeRetired(pending)) return { refused: CloseCode.RateLimited, reason: "the typed code is retired" };
      const reserved = { ...pending, codeAttempts: pending.codeAttempts + 1 };
      this.#write(reserved);
      return this.#claim(reserved, { mode: "code", code: reserved.code }, codeRetired(reserved));
    });
  }

  /** Claims the live offer's link secret; link attempts are not counted (the secret has 256 bits). */
  claimLink(now = Date.now(), mesh = false): PairingClaim | ClaimRefusal {
    const pending = this.#live(now, (expired) => this.#removeIf(expired));
    if ("refused" in pending) return pending;
    if (pending.mesh !== mesh) return kindRefusal(mesh);
    return this.#claim(pending, { mode: "link", linkSecret: pending.linkSecret }, false);
  }

  /**
   * Withdraws a mesh offer, live or expired, because this host is joining another mesh (#1301); a device offer stays.
   * True when one was withdrawn: a claim already taken on it is never spent, so it cannot admit anyone later.
   */
  withdrawMesh(): boolean {
    return this.#locked(() => {
      const pending = this.read();
      if (pending?.mesh !== true) return false;
      this.#removeIfHeld(pending);
      return true;
    });
  }

  /** Deletes the offer once it expired, so its relay slot is released. */
  expire(now = Date.now()): void {
    const pending = this.read();
    if (pending !== undefined && now >= pending.expiresAt) this.#removeIf(pending);
  }

  read(): PendingPairing | undefined {
    const value = readJson(this.#path);
    if (value === undefined) return undefined;
    if (isRecord(value) && value["version"] === 2) {
      removeFile(this.#path);
      this.#log("pairing offer from an older doriface-host discarded; run doriface-host pair again");
      return undefined;
    }
    if (!isRecord(value) || value["version"] !== VERSION) throw new Error(`${FILE}: unsupported format`);
    const expiresAt = Date.parse(stringField(value, "expiresAt", FILE));
    const slot = value["slot"];
    const codeAttempts = value["codeAttempts"];
    const linkSecret = base64urlDecode(stringField(value, "linkSecret", FILE));
    if (Number.isNaN(expiresAt) || !Number.isSafeInteger(codeAttempts) || typeof codeAttempts !== "number") {
      throw new Error(`${FILE}: malformed`);
    }
    if (slot !== "pending" && slot !== "registered" && slot !== "unavailable") throw new Error(`${FILE}: bad slot`);
    if (linkSecret.byteLength !== 32) throw new Error(`${FILE}: bad link secret`);
    const mesh = value["mesh"] === true;
    return { code: stringField(value, "code", FILE), linkSecret, expiresAt, slot, codeAttempts, mesh };
  }

  /** Reports every change this store makes (a pairing used up or burned, a code redrawn, an attempt reserved). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The live offer, or why there is none; `remove` deletes an expired one (with or without the lock held). */
  #live(now: number, remove: (expired: PendingPairing) => void): PendingPairing | ClaimRefusal {
    const pending = this.read();
    if (pending === undefined) return { refused: CloseCode.UnknownDevice, reason: "no pairing is pending" };
    if (now >= pending.expiresAt) {
      remove(pending);
      return { refused: CloseCode.UnknownDevice, reason: "the pairing offer expired" };
    }
    return pending;
  }

  #claim(pending: PendingPairing, secret: HostPairingSecret, retiredCode: boolean): PairingClaim {
    if (this.#guard?.offer.linkSecret.toHex() !== pending.linkSecret.toHex()) this.#guard = new PairingGuard(pending);
    const guard = this.#guard;
    return {
      secret,
      retiredCode,
      complete: (at = Date.now()) =>
        this.#locked(() => {
          if (pending.mesh && this.read()?.linkSecret.toHex() !== pending.linkSecret.toHex()) return false;
          const first = guard.use(at);
          if (first || guard.state === "expired") this.#removeIfHeld(pending);
          return first;
        }),
    };
  }

  #write(pending: PendingPairing): void {
    writePrivateJson(this.#path, {
      version: VERSION,
      code: pending.code,
      linkSecret: base64urlEncode(pending.linkSecret),
      expiresAt: new Date(pending.expiresAt).toISOString(),
      slot: pending.slot,
      codeAttempts: pending.codeAttempts,
      ...(pending.mesh ? { mesh: true } : {}),
    });
    this.#changed();
  }

  #removeIf(offer: PendingPairing): void {
    this.#locked(() => this.#removeIfHeld(offer));
  }

  /** Removes the offer if the file still holds it (a newer `pair` may have replaced it); the caller holds the lock. */
  #removeIfHeld(offer: PendingPairing): void {
    if (this.read()?.linkSecret.toHex() !== offer.linkSecret.toHex()) return;
    removeFile(this.#path);
    this.#changed();
  }

  #locked<T>(fn: () => T): T {
    return withStateLock(this.#dir, fn, this.#lockTimeoutMs);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
