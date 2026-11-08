import { base64urlEncode, generateHostIdentity } from "@doriface/crypto";
import { hashOf, meshIdOf, signCard, signRecord } from "@doriface/mesh";
import { cardBodyFor } from "@doriface/mesh/join";

/** Real signed records for presentation tests; transport/join acceptance uses the live host harness separately. */
export function browserMeshFixture() {
  const a = generateHostIdentity();
  const b = generateHostIdentity();
  const browser = generateHostIdentity();
  const pub = (who: typeof a) => base64urlEncode(who.sign.publicKey);
  const card = (who: typeof a, name: string, mesh: string, inviter: string, client = false) =>
    signCard(cardBodyFor({ ...who, noisePub: who.noise.publicKey },
      { name, hcId: client ? "" : "core", devicePub: base64urlEncode(who.noise.publicKey) },
      { mesh, inviter, kind: client ? "client" : "machine" }), who.sign.secretKey);
  const found = signRecord({ v: 2, mesh: "-", type: "found", by: pub(a), n: 1, prev: [], subject: { card: card(a, "studio", "-", "-") } }, a.sign.secretKey);
  const mesh = meshIdOf(found);
  const second = signRecord({ v: 2, mesh, type: "admit", by: pub(a), n: 2, prev: [hashOf(found)], subject: { card: card(b, "workshop", mesh, pub(a)) } }, a.sign.secretKey);
  const admit = signRecord({ v: 2, mesh, type: "admit", by: pub(a), n: 3, prev: [hashOf(second)], subject: { card: card(browser, "my-browser", mesh, pub(a), true) } }, a.sign.secretKey);
  return { mesh, records: [found, second, admit], cardSecret: [...browser.sign.secretKey], deviceSecret: [...browser.noise.secretKey] };
}
