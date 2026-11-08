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

export async function browserInvite(inviter: MeshHost, relayUrl: string): Promise<PairingOffer> {
  const pending = pendingFromWire(await requestControl(inviter.stateDir, { op: "mesh-pair", auto: false }));
  const identity = identityOf(inviter);
  const url = buildPairingUrl({
    hostId: identity.hostId,
    noiseStaticPub: identity.noise.publicKey,
    signPub: identity.sign.publicKey,
    linkSecret: pending.linkSecret,
    relayUrl,
    mesh: true,
    webOrigin: "https://web.example",
  });
  const parsed = parsePairingFragment(new URL(url).hash);
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
    confirm: async (code) => {
      const anchor = await loadJoinAnchor(browser.storage);
      const pending = await requestControl(inviter.stateDir, { op: "mesh-pending" });
      if (
        !isJsonObject(pending) ||
        pending["code"] !== code ||
        pending["nonce"] !== anchor?.offer.nonce ||
        typeof pending["nonce"] !== "string"
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
    },
  });
}
