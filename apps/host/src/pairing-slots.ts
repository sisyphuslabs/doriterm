import { pairingSlotOf } from "@doriface/crypto";
import { codeRetired, type PairingStore, type PendingPairing } from "./state/pairing.ts";

/**
 * The relay side of typed-code pairing: the host uplink's PAIR_SLOT control frame (type 4, payload = the 3 ASCII slot
 * characters). The integration with the relay client supplies it; without one, typed codes are marked unavailable and
 * only the link or QR code pairs.
 */
export interface PairingSlotRegistrar {
  /**
   * Registers the slot with this host's Noise static key, signed with its signing key together with the offer's
   * expiry `expiresAt` (contract v1.8); "collision" when another host holds the slot.
   */
  register(slot: string, noiseStaticPub: Uint8Array, expiresAt: number): Promise<"registered" | "collision">;
  /** The offer behind the slot ended (paired, expired or replaced): send the empty PAIR_SLOT (`PAIR_SLOT_CLEAR`). */
  release(slot: string): void;
}

const MAX_REDRAWS = 8;

/** Keeps the pending offer's slot registered with the relay, drawing a new code on a collision. */
export class PairingSlots {
  readonly #store: PairingStore;
  readonly #registrar: PairingSlotRegistrar | undefined;
  readonly #noiseStaticPub: Uint8Array;
  readonly #log: (line: string) => void;
  /** The code whose slot this instance registered; a `registered` status left by an earlier process is not ours. */
  #registered: string | undefined;
  #expiry: { readonly code: string; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  #running: Promise<void> = Promise.resolve();
  #opening: Promise<void> = Promise.resolve();
  #stopWatch: (() => void) | undefined;
  #stopped = false;
  #relayGone = false;
  #retry: ReturnType<typeof setTimeout> | undefined;
  readonly #retryMs: number;

  constructor(
    store: PairingStore,
    noiseStaticPub: Uint8Array,
    registrar: PairingSlotRegistrar | undefined,
    log: (line: string) => void,
    /** How long to wait before trying again after the relay failed a registration. */
    retryMs = 5000,
  ) {
    this.#retryMs = retryMs;
    this.#store = store;
    this.#noiseStaticPub = noiseStaticPub;
    this.#registrar = registrar;
    this.#log = log;
  }

  /** Follows the store's own changes and registers an offer left by `pair` while no host ran. */
  start(): void {
    this.#stopped = false;
    this.#stopWatch ??= this.#store.onChange(() => this.sync());
    this.sync();
  }

  /**
   * Opens a new offer (replacing any pending one) and resolves once its slot is settled with the relay. Opens run one
   * after another, so no caller is handed a code that a concurrent open is still drawing or registering.
   */
  open(mesh = false): Promise<PendingPairing> {
    const opened = this.#opening.then(() => this.#open(mesh));
    this.#opening = opened.then(
      () => undefined,
      () => undefined,
    );
    return opened;
  }

  async #open(mesh: boolean): Promise<PendingPairing> {
    const offer = this.#store.offer(Date.now(), mesh);
    this.sync();
    await this.#running;
    return this.#store.read() ?? offer;
  }

  /** Stops following the store; a registration still in flight is released when it answers. */
  stop(): void {
    this.#stopped = true;
    this.#stopWatch?.();
    this.#stopWatch = undefined;
    clearTimeout(this.#retry);
    this.#disarm();
    this.#release();
  }

  /** Re-reads the offer and brings the relay in line; runs one sync at a time. */
  sync(): void {
    this.#enqueue(() => this.#sync());
  }

  /** The uplink stopped for good (relay auth failed or replaced): register nothing more and stop retrying. */
  relayGone(): void {
    this.#relayGone = true;
    clearTimeout(this.#retry);
    this.sync();
  }

  /** A fresh uplink holds no slot, so the pending offer registers again. */
  relayConnected(): void {
    this.#enqueue(() => {
      this.#forget();
      return this.#sync();
    });
  }

  #enqueue(step: () => Promise<void>): void {
    this.#running = this.#running.then(step).catch((error: unknown) => {
      this.#log(`pairing slot: ${String(error)}; retrying`);
      this.#scheduleRetry();
    });
  }

  async #sync(): Promise<void> {
    if (this.#stopped) return;
    const pending = this.#store.read();
    const live = pending !== undefined && Date.now() < pending.expiresAt;
    if (!live || pending.code !== this.#registered) this.#release();
    if (!live) {
      this.#disarm();
      return this.#store.expire();
    }
    this.#arm(pending);
    if (codeRetired(pending)) return this.#release();
    if (pending.slot === "unavailable" || (pending.slot === "registered" && pending.code === this.#registered)) return;
    if (this.#registrar === undefined || this.#relayGone) return this.#store.setSlot(pending.code, "unavailable");
    return this.#register(this.#registrar, pending, 0);
  }

  async #register(registrar: PairingSlotRegistrar, pending: PendingPairing, redraws: number): Promise<void> {
    if (redraws >= MAX_REDRAWS) return this.#store.setSlot(pending.code, "unavailable");
    const slot = pairingSlotOf(pending.code);
    const answer = await registrar.register(slot, this.#noiseStaticPub, pending.expiresAt);
    if (this.#stopped) {
      if (answer === "registered") registrar.release(slot);
      return;
    }
    if (answer === "registered") {
      this.#registered = pending.code;
      return this.#store.setSlot(pending.code, "registered");
    }
    const next = this.#store.redraw(pending.code);
    if (next === undefined || next.slot !== "pending") return;
    return this.#register(registrar, next, redraws + 1);
  }

  /** A failed registration is tried again while the offer lives; `#sync` drops an expired one. */
  #scheduleRetry(): void {
    if (this.#stopped || this.#relayGone) return;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => this.sync(), this.#retryMs);
  }

  /** Re-syncs when the live offer expires, whether or not its slot is registered. */
  #arm(pending: PendingPairing): void {
    if (this.#expiry?.code === pending.code) return;
    this.#disarm();
    const timer = setTimeout(() => this.sync(), Math.max(0, pending.expiresAt - Date.now()));
    this.#expiry = { code: pending.code, timer };
  }

  #disarm(): void {
    if (this.#expiry !== undefined) clearTimeout(this.#expiry.timer);
    this.#expiry = undefined;
  }

  #release(): void {
    const registered = this.#forget();
    if (registered !== undefined) this.#registrar?.release(pairingSlotOf(registered));
  }

  #forget(): string | undefined {
    const registered = this.#registered;
    this.#registered = undefined;
    return registered;
  }
}
