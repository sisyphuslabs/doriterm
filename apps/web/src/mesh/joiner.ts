import { base64urlEncode, type KeyPair, type StaticKey } from "@doriface/crypto";
import {
  checkWelcome,
  type JoinAnchor,
  JOIN_DEADLINE_MS,
  JOINER_EXPECTS,
  type LineLink,
  type MeshInvite,
  MeshLines,
  runJoinCeremony,
} from "@doriface/mesh/join";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { CardKey } from "../connection/card-key.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { JOIN_ANCHOR_KEY, type BrowserJoinAnchor } from "../pair/join-anchor.ts";
import { browserCard } from "./browser-card.ts";
import { memberIdentityOf } from "./identity.ts";
import { type BrowserMembership, type MembershipStore, membersOf, type MeshMember } from "./membership.ts";

/** The member the browser dialed and authenticated: the inviter's hostId and the Noise key the handshake proved. */
export interface Inviter {
  readonly hostId: string;
  readonly hostKey: Uint8Array;
  readonly relayUrl: string;
}

export interface BrowserJoinerDeps {
  readonly invite: MeshInvite;
  readonly sign: CardKey | KeyPair;
  /** The device key: the Noise static the session proved, and the key the card names as this client's `devicePub`. */
  readonly device: StaticKey;
  readonly name: string;
  readonly membership: MembershipStore;
  readonly log?: ((line: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly handshakeHash: Uint8Array;
  readonly confirm?: ((code: string) => Promise<boolean>) | undefined;
  readonly storage?: KeyValueStore;
  readonly resume?: BrowserJoinAnchor;
  readonly expiresAt?: number;
  readonly inviterName?: string;
}

export interface BrowserJoined {
  readonly meshId: string;
  readonly membership: BrowserMembership;
  readonly members: readonly MeshMember[];
}

/**
 * The joiner role on an authenticated mesh session (the shared `runJoiner`), as a browser runs it: a version 2 card of
 * kind `client`, signed by this browser's own key, naming its device key as both Noise static and `devicePub`; the
 * checked welcome goes to the membership store, which refuses it if another mesh was adopted meanwhile.
 */
export async function joinOnLink(
  link: LineLink | MeshLines,
  inviter: Inviter,
  deps: BrowserJoinerDeps,
): Promise<BrowserJoined> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => {});
  const storage = deps.storage ?? deviceStore;
  const sign = deps.sign;
  const card: CardKey =
    "secretKey" in sign
      ? {
          kind: "raw",
          publicKey: sign.publicKey,
          sign: async (message) => ed25519.sign(message, sign.secretKey),
        }
      : sign;
  const lines = link instanceof MeshLines ? link : new MeshLines(link, JOINER_EXPECTS);
  let welcomed = false;
  try {
    const welcome = await runJoinCeremony(lines, {
      kind: "client",
      handshakeHash: deps.handshakeHash,
      dialed: { hostId: inviter.hostId, noisePub: base64urlEncode(inviter.hostKey) },
      expiresAt: deps.expiresAt ?? now() + JOIN_DEADLINE_MS,
      yes: false,
      confirm: deps.confirm,
      card: (offer) => browserCard({ card, device: deps.device }, deps.name, offer),
      saveAnchor: (anchor: JoinAnchor) =>
        storage.put(JOIN_ANCHOR_KEY, {
          ...anchor,
          name: deps.name,
          relayUrl: inviter.relayUrl,
          inviterName: deps.inviterName ?? "the inviting machine",
        } satisfies BrowserJoinAnchor),
      clearAnchor: () => storage.put(JOIN_ANCHOR_KEY, null),
      ...(deps.resume === undefined ? {} : { resume: deps.resume }),
    });
    welcomed = true;
    checkWelcome(welcome.records, welcome.offer, {
      identity: memberIdentityOf(card, deps.device.publicKey),
      kind: "client",
      dialed: { hostId: inviter.hostId, noisePub: inviter.hostKey },
    });
    const next: BrowserMembership = {
      meshId: welcome.offer.mesh,
      records: welcome.records,
      signPub: base64urlEncode(card.publicKey),
      inviter: { hostId: inviter.hostId, hostKey: base64urlEncode(inviter.hostKey) },
      relayUrl: inviter.relayUrl,
      joinedAt: new Date(now()).toISOString(),
    };
    if (!(await deps.membership.adopt(next))) throw new Error("a mesh appeared on this member meanwhile");
    await storage.put(JOIN_ANCHOR_KEY, null);
    const stored = await deps.membership.read();
    if (stored === undefined) throw new Error("the joined membership was cleared");
    log("mesh: browser joined");
    return { meshId: next.meshId, membership: stored, members: membersOf(stored.records) };
  } catch (error) {
    // A checked ceremony may still deliver a forged welcome. Never resume that attempt.
    if (welcomed) await storage.put(JOIN_ANCHOR_KEY, null);
    throw error;
  } finally {
    lines.close(1000, "join complete");
  }
}
