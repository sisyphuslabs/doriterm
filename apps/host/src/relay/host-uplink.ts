import type { HostIdentity } from "@doriface/crypto";
import {
  type CreateSocket,
  ed25519Signer,
  type RelayProofs,
  LinkClosedError,
  type SessionLink,
  type SessionRefusal,
  Uplink,
  type UplinkState,
} from "@doriface/relay-client";
import type { PairingSlotRegistrar } from "../pairing-slots.ts";

export interface HostUplinkOptions {
  readonly relayUrl: string;
  readonly identity: HostIdentity;
  readonly log: (line: string) => void;
  readonly createSocket?: CreateSocket | undefined;
  /** This host's relay passes (contract v1.6): the uplink asks for passes and presents proofs. */
  readonly proofs?: RelayProofs | undefined;
}

export interface UplinkHandlers {
  readonly onSession: (session: SessionLink) => void;
  /** The relay took this uplink's challenge answer; it holds no pairing slot for this host yet. */
  readonly onConnected: () => void;
  /** The uplink closed and will reconnect. */
  readonly onDropped?: () => void;
  /** The uplink stopped for good with a final close (4403, 4409); it will not reconnect. */
  readonly onFinalClose?: () => void;
}

const FINAL_REASONS: Readonly<Record<number, string>> = {
  4403: "the relay refused this host's key",
  4409: "another doriface-host with this identity took over the uplink",
};

/**
 * A close as the log shows it: the code, and the relay's reason beside it when it gave one (`4408: idle`), which tells
 * an idle timeout from a relay that ran too far ahead of this host. The reason is the relay's text, so only its
 * printable ASCII reaches the log.
 */
const closeOf = (code: number, reason: string): string =>
  reason === "" ? String(code) : `${code}: ${reason.replaceAll(/[^\x20-\x7e]/g, "?")}`;

const REFUSALS: Readonly<Record<SessionRefusal["reason"], string>> = {
  pending_cap: "8 sessions were already waiting for the host's answer",
  active_cap: "32 sessions were already active",
};

/** The host's authenticated uplink to the relay; it also registers typed-code pairing slots over that uplink. */
export class HostUplink implements PairingSlotRegistrar {
  readonly #options: HostUplinkOptions;
  #uplink: Uplink | undefined;
  #releasing: Promise<void> = Promise.resolve();

  constructor(options: HostUplinkOptions) {
    this.#options = options;
  }

  async start(handlers: UplinkHandlers): Promise<void> {
    const { relayUrl, identity, createSocket, proofs, log } = this.#options;
    // One line per kind of refusal and uplink connection: a relay that floods OPENs cannot flood the log as well.
    let told = new Set<SessionRefusal["reason"]>();
    this.#uplink = await Uplink.start({
      relayUrl,
      signer: ed25519Signer(identity.sign.secretKey),
      onSession: handlers.onSession,
      onUnsignedPairSlot: (slot) =>
        log(
          `relay: the relay refused the signed pairing slot ${slot}, so it went unsigned; clients from v1.9 refuse a typed code until the relay is updated (#22)`,
        ),
      onRefused: ({ sessionId, reason }) => {
        if (told.has(reason)) return;
        told.add(reason);
        log(`relay: refused session ${sessionId} with 4429: ${REFUSALS[reason]} (the relay should not have opened it)`);
      },
      onState: (state) => {
        if (state.state === "answered") told = new Set();
        this.#report(state);
        if (state.state === "answered") handlers.onConnected();
        if (state.state === "waiting") handlers.onDropped?.();
        if (state.state === "stopped" && state.code !== 1000) handlers.onFinalClose?.();
      },
      ...(createSocket === undefined ? {} : { createSocket }),
      ...(proofs === undefined ? {} : { proofs }),
    });
  }

  async register(slot: string, noiseStaticPub: Uint8Array, expiresAt: number): Promise<"registered" | "collision"> {
    const uplink = this.#uplink;
    if (uplink === undefined) throw new LinkClosedError("the relay uplink has not started");
    return (await uplink.registerPairSlot(slot, noiseStaticPub, expiresAt)) === "taken" ? "collision" : "registered";
  }

  release(): void {
    const uplink = this.#uplink;
    if (uplink === undefined) return;
    this.#releasing = uplink.clearPairSlot().catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      this.#options.log(`relay: could not release the pairing slot: ${why}`);
    });
  }

  /** Waits for a slot release in flight, so the relay frees the slot before the uplink closes. */
  async stop(): Promise<void> {
    await this.#releasing;
    this.#uplink?.stop();
  }

  #report(state: UplinkState): void {
    const { log, relayUrl } = this.#options;
    switch (state.state) {
      case "connecting":
        if (state.attempt === 0) log(`relay: connecting to ${relayUrl}`);
        return;
      case "answered":
        return log(`relay: connected to ${relayUrl}`);
      case "waiting":
        return log(
          `relay: uplink closed (${closeOf(state.code, state.reason)}); reconnecting in ${Math.ceil(state.retryInMs / 1000)} s`,
        );
      case "stopped":
        if (state.code !== 1000)
          log(`relay: uplink stopped (${state.code}): ${FINAL_REASONS[state.code] ?? "gave up"}`);
        return;
    }
  }
}
