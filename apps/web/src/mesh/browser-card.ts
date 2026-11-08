import { base64urlEncode, concatBytes, hostIdOf } from "@doriface/crypto";
import { checkName, encodeBody, type CardBody, type Signed } from "@doriface/mesh";
import type { Offer } from "@doriface/mesh/join";
import { sha256 } from "@noble/hashes/sha2.js";
import type { BrowserIdentity } from "../connection/browser-identity.ts";

/** Card custody uses the existing card signature domain, with an async non-extractable signing key. */
export async function browserCard(identity: BrowserIdentity, name: string, offer: Offer): Promise<Signed> {
  if (!checkName(name)) throw new Error("Use 1-32 lowercase letters, digits, dots, underscores or hyphens.");
  const body: CardBody = {
    v: 2,
    kind: "client",
    mesh: offer.mesh,
    inviter: offer.inviter,
    nonce: offer.nonce,
    hostId: hostIdOf(identity.card.publicKey),
    signPub: base64urlEncode(identity.card.publicKey),
    noisePub: base64urlEncode(identity.device.publicKey),
    devicePub: base64urlEncode(identity.device.publicKey),
    hcId: "",
    name,
  };
  const encoded = encodeBody(body);
  const utf8 = new TextEncoder();
  const message = concatBytes(utf8.encode("doriface-mesh/1 card"), sha256(utf8.encode(encoded)));
  return { body: encoded, sig: base64urlEncode(await identity.card.sign(message)) };
}
