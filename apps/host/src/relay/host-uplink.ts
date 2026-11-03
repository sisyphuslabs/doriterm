import type { HostIdentity } from "@doriface/crypto";
import {
  type CreateSocket,
  ed25519Signer,
  LinkClosedError,
  type SessionLink,
  Uplink,
  type UplinkState,
} from "@doriface/relay-client";
import type { PairingSlotRegistrar } from "../pairing-slots.ts";

export interface HostUplinkOptions {
  readonly relayUrl: string;
  readonly identity: HostIdentity;
  readonly log: (line: string) => void;
  readonly createSocket?: CreateSocket | undefined;
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

/** The host's authenticated uplink to the relay; it also registers typed-code pairing slots over that uplink. */
export class HostUplink implements PairingSlotRegistrar {
  readonly #options: HostUplinkOptions;
  #uplink: Uplink | undefined;
  #releasing: Promise<void> = Promise.resolve();

  constructor(options: HostUplinkOptions) {
    this.#options = options;
  }

  async start(handlers: UplinkHandlers): Promise<void> {
    const { relayUrl, identity, createSocket } = this.#options;
    this.#uplink = await Uplink.start({
      relayUrl,
      signer: ed25519Signer(identity.sign.secretKey),
      onSession: handlers.onSession,
      onState: (state) => {
        this.#report(state);
        if (state.state === "answered") handlers.onConnected();
        if (state.state === "waiting") handlers.onDropped?.();
        if (state.state === "stopped" && state.code !== 1000) handlers.onFinalClose?.();
      },
      ...(createSocket === undefined ? {} : { createSocket }),
    });
  }

  async register(slot: string, noiseStaticPub: Uint8Array): Promise<"registered" | "collision"> {
    const uplink = this.#uplink;
    if (uplink === undefined) throw new LinkClosedError("the relay uplink has not started");
    return (await uplink.registerPairSlot(slot, noiseStaticPub)) === "taken" ? "collision" : "registered";
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
        return log(`relay: uplink closed (${state.code}); reconnecting in ${Math.ceil(state.retryInMs / 1000)} s`);
      case "stopped":
        if (state.code !== 1000)
          log(`relay: uplink stopped (${state.code}): ${FINAL_REASONS[state.code] ?? "gave up"}`);
        return;
    }
  }
}
