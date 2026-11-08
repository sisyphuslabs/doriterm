import { closeCodeOf } from "@doriface/crypto";
import { JOIN_NO_COMMIT, JoinRefused, runJoinCeremony, type MeshLines } from "@doriface/mesh/join";
import type { BrowserIdentity } from "../connection/browser-identity.ts";
import { browserCard } from "../mesh/browser-card.ts";
import { BundleRefused, type BundleStore } from "../mesh/bundle-store.ts";
import type { KeyValueStore } from "../storage/idb.ts";
import { JOIN_ANCHOR_KEY, type BrowserJoinAnchor } from "./join-anchor.ts";

export { loadJoinAnchor } from "./join-anchor.ts";

export type BrowserJoinState =
  | { readonly phase: "connecting" | "joined" | "interrupted" | "mismatch" }
  | { readonly phase: "comparing" | "waiting"; readonly code: string }
  | { readonly phase: "refused"; readonly reason: string };

export interface BrowserJoinContext {
  readonly name: string;
  readonly relayUrl: string;
  readonly inviterName: string;
  readonly dialed: BrowserJoinAnchor["dialed"];
  readonly expiresAt: number;
  readonly resume?: BrowserJoinAnchor;
}

/** UI and persistence around the shared wire ceremony. This class never implements commitment or resume messages. */
export class BrowserJoin {
  readonly #storage: KeyValueStore;
  readonly #identity: BrowserIdentity;
  readonly #bundle: BundleStore;
  readonly #listeners = new Set<() => void>();
  #state: BrowserJoinState = { phase: "connecting" };
  #answer: PromiseWithResolvers<boolean> | undefined;
  #lines: MeshLines | undefined;
  #mismatch = false;

  constructor(storage: KeyValueStore, identity: BrowserIdentity, bundle: BundleStore) {
    this.#storage = storage;
    this.#identity = identity;
    this.#bundle = bundle;
  }

  snapshot = (): BrowserJoinState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #show(state: BrowserJoinState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  answer(matches: boolean): void {
    if (this.#state.phase !== "comparing") return;
    this.#mismatch = !matches;
    if (matches) this.#show({ phase: "waiting", code: this.#state.code });
    this.#answer?.resolve(matches);
  }

  stop(): void {
    this.#lines?.close(1000, "join page closed");
  }

  async run(
    session: { readonly lines: MeshLines; readonly handshakeHash: Uint8Array },
    context: BrowserJoinContext,
  ): Promise<void> {
    this.#lines = session.lines;
    this.#mismatch = false;
    this.#show({ phase: "connecting" });
    try {
      const welcome = await runJoinCeremony(session.lines, {
        kind: "client",
        handshakeHash: session.handshakeHash,
        dialed: context.dialed,
        expiresAt: context.expiresAt,
        yes: false,
        ...(context.resume === undefined ? {} : { resume: context.resume }),
        card: (offer) => browserCard(this.#identity, context.name, offer),
        saveAnchor: (anchor) => this.#storage.put(JOIN_ANCHOR_KEY, {
          ...anchor,
          name: context.name,
          relayUrl: context.relayUrl,
          inviterName: context.inviterName,
        }),
        clearAnchor: () => this.#storage.put(JOIN_ANCHOR_KEY, null),
        confirm: (code) => {
          this.#answer = Promise.withResolvers<boolean>();
          this.#show({ phase: "comparing", code });
          return this.#answer.promise;
        },
      });
      await this.#bundle.accept(welcome.records, {
        mesh: welcome.offer.mesh,
        inviter: welcome.offer.inviter,
        hostId: context.dialed.hostId,
        hostKey: context.dialed.noisePub,
      });
      await this.#storage.put(JOIN_ANCHOR_KEY, null);
      this.#show({ phase: "joined" });
      session.lines.close(1000, "joined");
    } catch (error) {
      const refusedResume = context.resume !== undefined &&
        (error instanceof JoinRefused || (error instanceof Error && closeCodeOf(error) === 4401));
      if (refusedResume || error instanceof BundleRefused) await this.#storage.put(JOIN_ANCHOR_KEY, null);
      if (this.#mismatch) {
        this.#show({ phase: "mismatch" });
      } else if (!refusedResume && await this.#storage.get(JOIN_ANCHOR_KEY) != null) {
        this.#show({ phase: "interrupted" });
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        this.#show({
          phase: "refused",
          reason: refusedResume ? "Ask for a new invite" : reason === JOIN_NO_COMMIT
            ? "This machine needs an update, or this is an Add a machine invite. Ask for an invite for a browser with doriface-host mesh pair."
            : reason,
        });
      }
    } finally {
      this.#answer = undefined;
    }
  }
}
