import { buildPairingUrl, type StaticKey } from "@doriface/crypto";
import { isJsonObject } from "@doriface/protocol";
import { requestControl } from "../../../apps/host/src/control.ts";
import { pendingFromWire } from "../../../apps/host/src/state/pairing.ts";
import { joinMesh } from "../../../apps/web/src/mesh/join.ts";
import type { BrowserJoined, BrowserJoinerDeps } from "../../../apps/web/src/mesh/joiner.ts";
import type { MembershipStore } from "../../../apps/web/src/mesh/membership.ts";
import { parsePairingFragment, type PairingOffer } from "../../../apps/web/src/pair/fragment.ts";
import { loadJoinAnchor } from "../../../apps/web/src/pair/join-anchor.ts";
import type { KeyValueStore } from "../../../apps/web/src/storage/idb.ts";
import { identityOf } from "./mesh/identity.ts";
import type { MeshHost } from "./mesh/mesh-host.ts";

/** A mesh invite that asks for a code, as `mesh pair` without --auto mints it: the only kind a browser may join on. */
export async function browserInviteUrl(inviter: MeshHost, relayUrl: string): Promise<string> {
  const pending = pendingFromWire(await requestControl(inviter.stateDir, { op: "mesh-pair", auto: false }));
  const identity = identityOf(inviter);
  return buildPairingUrl({
    hostId: identity.hostId,
    noiseStaticPub: identity.noise.publicKey,
    signPub: identity.sign.publicKey,
    linkSecret: pending.linkSecret,
    relayUrl,
    mesh: true,
    webOrigin: "https://web.example",
  });
}

export async function browserInvite(inviter: MeshHost, relayUrl: string): Promise<PairingOffer> {
  const parsed = parsePairingFragment(new URL(await browserInviteUrl(inviter, relayUrl)).hash);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.offer;
}

/** Exercise the actual web joiner; the test supplies only the two people's out-of-band comparison. */
export function joinComparedBrowser(
  inviter: MeshHost,
  offer: PairingOffer,
  name: string,
  browser: {
    readonly device: StaticKey;
    readonly sign: BrowserJoinerDeps["sign"];
    readonly membership: MembershipStore;
    readonly storage: KeyValueStore;
  },
): Promise<BrowserJoined> {
  return joinMesh(offer, name, {
    loadDeviceKey: async () => browser.device,
    loadSignKey: async () => browser.sign,
    membership: browser.membership,
    storage: browser.storage,
    confirm: async (code) => approveOnInviter(inviter, code, (await loadJoinAnchor(browser.storage))?.offer.nonce),
  });
}

/**
 * The inviting person's half of the comparison: approves the pending join on `inviter` when it shows `code` (and, given
 * one, is the join for `nonce`); throws when the two sides did not display the same code.
 */
export async function approveOnInviter(inviter: MeshHost, code: string, nonce?: string): Promise<true> {
  const pending = await requestControl(inviter.stateDir, { op: "mesh-pending" });
  if (
    !isJsonObject(pending) ||
    pending["code"] !== code ||
    typeof pending["nonce"] !== "string" ||
    (nonce !== undefined && pending["nonce"] !== nonce)
  ) {
    throw new Error("the two sides did not display the same join code");
  }
  const reply = await requestControl(inviter.stateDir, {
    op: "mesh-approve",
    nonce: pending["nonce"],
    approve: true,
    code,
  });
  if (!isJsonObject(reply) || reply["decided"] !== true) throw new Error("the inviting person did not approve");
  return true;
}
