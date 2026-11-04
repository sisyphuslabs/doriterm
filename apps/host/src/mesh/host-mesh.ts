import { DEFAULT_RELAY_URL, type HostIdentity, PAIRING_TTL_MS, type SecureLink, SessionKind } from "@doriface/crypto";
import { PairingStore } from "../state/pairing.ts";
import type { CreateSocket, RelayProofs } from "@doriface/relay-client";
import { parseTarget } from "../connect/target.ts";
import type { LiveSessions } from "../e2ee/sessions.ts";
import type { PairingSlots } from "../pairing-slots.ts";
import type { MeshStore, OwnCard } from "../state/mesh.ts";
import type { PendingPairing } from "../state/pairing.ts";
import { type HcCore, type HcCoreOptions, hcCoreReader } from "./hc-core.ts";
import { serveJoin } from "./invite.ts";
import { joinMesh } from "./join-dial.ts";
import { INVITER_EXPECTS, MeshLines } from "./lines.ts";
import { PendingJoins } from "./pending-joins.ts";

export interface HostMeshOptions {
  readonly stateDir: string;
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly slots: PairingSlots;
  readonly sessions: LiveSessions;
  readonly hc: HcCoreOptions;
  readonly relay: {
    readonly url: string | undefined;
    readonly createSocket?: CreateSocket | undefined;
    readonly proofs?: RelayProofs | undefined;
  };
  /**
   * The sync layer (section 5, PR 5): receives every authorized mesh session that is not a join, and the session a
   * join ran on once the join is over. It owns the session from then on. Without one, the session stays open and idle.
   */
  readonly sync?: ((session: SecureLink) => void) | undefined;
  readonly log: (line: string) => void;
}

export interface MeshJoinRequest {
  readonly target: string;
  readonly fingerprint: string | undefined;
  readonly name: string | undefined;
  readonly relay: string | undefined;
  readonly yes: boolean;
}

/**
 * The running host's side of joining (section 4): it opens mesh offers, serves the joins they admit, holds the
 * pending joins until the inviting member decides, and runs a `mesh join` itself so the session it opens can stay up
 * as a sync session.
 */
export class HostMesh {
  readonly pending = new PendingJoins();
  readonly #options: HostMeshOptions;
  readonly #core: () => Promise<HcCore>;
  #offerExpiresAt: number;

  constructor(options: HostMeshOptions) {
    this.#options = options;
    this.#core = hcCoreReader(options.hc);
    const offer = new PairingStore(options.stateDir).read();
    this.#offerExpiresAt = offer?.mesh === true ? offer.expiresAt : 0;
  }

  /**
   * Opens a mesh offer (replacing any pending offer, whose pending joins expire with it); with `auto`, its joins are
   * admitted without asking.
   */
  async pair(auto: boolean): Promise<PendingPairing> {
    this.pending.expireAll();
    const offer = await this.#options.slots.open(true);
    this.#offerExpiresAt = offer.expiresAt;
    this.pending.setAuto(auto ? offer.expiresAt : 0);
    return offer;
  }

  /** Opens a device offer, which replaces any mesh offer: that offer's pending joins expire with it. */
  pairDevice(): Promise<PendingPairing> {
    this.pending.expireAll();
    return this.#options.slots.open(false);
  }

  /** Serves a session on the mesh stream: a join on a mesh offer, or a member's sync session for the sync hook. */
  serve(secure: SecureLink): void {
    if (secure.kind === SessionKind.Session) return this.#options.sync?.(secure);
    const { identity, mesh, log } = this.#options;
    const expiresAt = this.#offerExpiresAt > 0 ? this.#offerExpiresAt : Date.now() + PAIRING_TTL_MS;
    const deps = { identity, mesh, pending: this.pending, own: () => this.#own(undefined), expiresAt, log };
    serveJoin(new MeshLines(secure, INVITER_EXPECTS), secure.remoteStatic, deps).then(
      () => this.#keep(secure),
      () => undefined,
    );
  }

  /** `mesh join` run by this host: refusals, the pairing handshake with the host key, the welcome, then it stays up. */
  async join(request: MeshJoinRequest): Promise<{ readonly meshId: string; readonly hostId: string }> {
    const { stateDir, identity, relay, log } = this.#options;
    const own = await this.#own(request.name);
    const joined = await joinMesh({
      stateDir,
      identity,
      target: parseTarget(request.target),
      fingerprint: request.fingerprint,
      name: own.name,
      hcId: own.hcId,
      yes: request.yes,
      confirm: async () => false,
      relayUrl: request.relay,
      defaultRelayUrl: relay.url ?? DEFAULT_RELAY_URL,
      createSocket: relay.createSocket,
      proofs: relay.proofs,
      log,
    });
    this.#keep(joined.secure);
    return { meshId: joined.meshId, hostId: joined.hostId };
  }

  /** The session a join ran on stays open as a sync session, registered so a revoke closes it. */
  #keep(secure: SecureLink): void {
    if (!this.#options.sessions.add(secure)) return;
    this.#options.log("mesh: keeping the join's session for sync");
    this.#options.sync?.(secure);
  }

  async #own(name: string | undefined): Promise<OwnCard> {
    const core = await this.#core();
    return { name: name ?? core.name, hcId: core.id };
  }
}
