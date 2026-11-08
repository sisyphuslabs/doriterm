import { base64urlEncode, buildPairingUrl, type KeyPair, secureLink, type StaticKey } from "@doriface/crypto";
import { signCard } from "../../../packages/mesh/src/index.ts";
import {
  cardBodyFor,
  checkWelcome,
  JOIN_DEADLINE_MS,
  JOINER_EXPECTS,
  type JoinAnchor,
  MeshLines,
  runJoinCeremony,
} from "../../../packages/mesh/src/join/index.ts";
import { isJsonObject } from "@doriface/protocol";
import { connectRelayClient } from "@doriface/relay-client";
import { requestControl } from "../../../apps/host/src/control.ts";
import { pendingFromWire } from "../../../apps/host/src/state/pairing.ts";
import { clientIdOf, memberIdentityOf } from "../../../apps/web/src/mesh/identity.ts";
import { refuseEarly } from "../../../apps/web/src/mesh/join.ts";
import { type BrowserJoined } from "../../../apps/web/src/mesh/joiner.ts";
import { meshNameOf } from "../../../apps/web/src/mesh/member-name.ts";
import { type BrowserMembership, type MembershipStore, membersOf } from "../../../apps/web/src/mesh/membership.ts";
import { parsePairingFragment, type PairingOffer } from "../../../apps/web/src/pair/fragment.ts";
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

/** A protocol client for the host's relay tests: real browser keys and storage, with both people comparing the code. */
export async function joinComparedBrowser(
  inviter: MeshHost,
  offer: PairingOffer,
  name: string,
  browser: { readonly device: StaticKey; readonly sign: KeyPair; readonly membership: MembershipStore },
): Promise<BrowserJoined> {
  await refuseEarly(offer, browser.membership);
  if (offer.secret.mode !== "link") throw new Error("this fixture needs the link printed by mesh pair");
  const memberName = meshNameOf(name);
  const wire = await connectRelayClient({ relayUrl: offer.relayUrl, hostId: offer.hostId });
  const secure = await secureLink(wire, {
    role: "initiator",
    hostId: offer.hostId,
    remoteStatic: offer.noiseStaticPub,
    staticKey: browser.device,
    stream: "mesh",
    pairing: { mode: "link", linkSecret: offer.secret.linkSecret, name: memberName },
  });
  const identity = memberIdentityOf(browser.sign, browser.device.publicKey);
  const own = {
    name: memberName,
    hcId: clientIdOf(browser.sign.publicKey),
    devicePub: base64urlEncode(browser.device.publicKey),
  };
  const dialed = { hostId: offer.hostId, noisePub: offer.noiseStaticPub };
  let anchor: JoinAnchor | undefined;
  try {
    const welcome = await runJoinCeremony(new MeshLines(secure, JOINER_EXPECTS), {
      kind: "client",
      handshakeHash: secure.handshakeHash,
      dialed: { hostId: dialed.hostId, noisePub: base64urlEncode(dialed.noisePub) },
      expiresAt: Date.now() + JOIN_DEADLINE_MS,
      yes: false,
      card: async (placement) =>
        signCard(cardBodyFor(identity, own, { ...placement, kind: "client" }), browser.sign.secretKey),
      saveAnchor: async (saved) => {
        anchor = saved;
      },
      clearAnchor: async () => {
        anchor = undefined;
      },
      confirm: async (code) => {
        const pending = await requestControl(inviter.stateDir, { op: "mesh-pending" });
        if (
          !isJsonObject(pending) ||
          pending["code"] !== code ||
          pending["nonce"] !== anchor?.offer.nonce ||
          typeof pending["nonce"] !== "string"
        )
          throw new Error("the two sides did not display the same join code");
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
    checkWelcome(welcome.records, welcome.offer, { identity, dialed, kind: "client" });
    const membership: BrowserMembership = {
      meshId: welcome.offer.mesh,
      records: welcome.records,
      signPub: base64urlEncode(browser.sign.publicKey),
      inviter: { hostId: offer.hostId, hostKey: base64urlEncode(offer.noiseStaticPub) },
      relayUrl: offer.relayUrl,
      joinedAt: new Date().toISOString(),
    };
    if (!(await browser.membership.adopt(membership))) throw new Error("this browser adopted another mesh");
    return { meshId: membership.meshId, membership, members: membersOf(membership.records) };
  } finally {
    secure.close();
  }
}
