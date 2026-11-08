import { base64urlDecode, secureLink, type SecureLink } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import type { BrowserIdentity } from "../connection/browser-identity.ts";
import type { PairingOffer } from "./fragment.ts";
import { slotOf } from "./code.ts";
import type { BrowserJoinAnchor } from "./join-anchor.ts";

export async function openBrowserJoin(
  offer: PairingOffer,
  identity: BrowserIdentity,
  name: string,
): Promise<SecureLink> {
  const link = await connectRelayClient({
    relayUrl: offer.relayUrl,
    hostId: offer.hostId,
    ...(offer.secret.mode === "code" ? { pairSlot: slotOf(offer.secret.code) } : {}),
  });
  try {
    return await secureLink(link, {
      role: "initiator",
      hostId: offer.hostId,
      staticKey: identity.device,
      remoteStatic: offer.noiseStaticPub,
      stream: "mesh",
      pairing: offer.secret.mode === "code"
        ? { mode: "code", code: offer.secret.code, name }
        : { mode: "link", linkSecret: offer.secret.linkSecret, name },
    });
  } catch (error) {
    link.close();
    throw error;
  }
}

export async function openBrowserResume(anchor: BrowserJoinAnchor, identity: BrowserIdentity): Promise<SecureLink> {
  return openRosterSession({ hostId: anchor.dialed.hostId, hostKey: anchor.dialed.noisePub, relayUrl: anchor.relayUrl }, identity);
}

/** The host PR extends the shared hello stream union with roster. All browser membership traffic uses the relay. */
export async function openRosterSession(
  member: { readonly hostId: string; readonly hostKey: string; readonly relayUrl: string },
  identity: BrowserIdentity,
): Promise<SecureLink> {
  const link = await connectRelayClient({ relayUrl: member.relayUrl, hostId: member.hostId });
  try {
    return await secureLink(link, {
      role: "initiator",
      hostId: member.hostId,
      staticKey: identity.device,
      remoteStatic: base64urlDecode(member.hostKey),
      stream: "roster",
    });
  } catch (error) {
    link.close();
    throw error;
  }
}
