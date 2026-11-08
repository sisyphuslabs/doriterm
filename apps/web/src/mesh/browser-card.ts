import { base64urlEncode, concatBytes } from "@doriface/crypto";
import { checkName, encodeBody, type Signed } from "@doriface/mesh";
import { cardBodyFor, type Offer } from "@doriface/mesh/join";
import { sha256 } from "@noble/hashes/sha2.js";
import { clientIdOf, memberIdentityOf, type BrowserIdentity } from "./identity.ts";

/** Card custody uses the existing card signature domain, with an async non-extractable signing key. */
export async function browserCard(identity: BrowserIdentity, name: string, offer: Offer): Promise<Signed> {
  if (!checkName(name)) throw new Error("Use 1-32 lowercase letters, digits, dots, underscores or hyphens.");
  const body = cardBodyFor(
    memberIdentityOf(identity.card, identity.device.publicKey),
    { name, hcId: clientIdOf(identity.card.publicKey), devicePub: base64urlEncode(identity.device.publicKey) },
    { ...offer, kind: "client" },
  );
  const encoded = encodeBody(body);
  const utf8 = new TextEncoder();
  const message = concatBytes(utf8.encode("doriface-mesh/1 card"), sha256(utf8.encode(encoded)));
  return { body: encoded, sig: base64urlEncode(await identity.card.sign(message)) };
}
