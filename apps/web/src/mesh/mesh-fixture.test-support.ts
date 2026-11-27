import { base64urlEncode, generateHostIdentity } from "@doriface/crypto";
import { hashOf, meshIdOf, signCard, signRecord, type Signed } from "@doriface/mesh";
import { cardBodyFor } from "@doriface/mesh/join";
import type { KeyValueStore } from "../storage/idb.ts";
import { DEFAULT_SLOT } from "./identity-slots.ts";
import { type BrowserMembership, MembershipStore } from "./membership.ts";

type Identity = ReturnType<typeof generateHostIdentity>;

const pub = (who: Identity) => base64urlEncode(who.sign.publicKey);
const card = (who: Identity, name: string, mesh: string, inviter: string, client = false) =>
  signCard(
    cardBodyFor(
      { ...who, noisePub: who.noise.publicKey },
      { name, hcId: client ? "" : "core", devicePub: base64urlEncode(who.noise.publicKey) },
      { mesh, inviter, kind: client ? "client" : "machine" },
    ),
    who.sign.secretKey,
  );

/** A real signed mesh: the first machine founds it and admits the others and one browser, as a host would. */
export function meshFixture(
  machines: readonly string[] = ["studio", "workshop"],
  browserName = "my-browser",
  browser: Identity = generateHostIdentity(),
) {
  const hosts = machines.map(() => generateHostIdentity());
  const founder = hosts[0];
  if (founder === undefined) throw new Error("a mesh needs a machine");
  const found = signRecord(
    {
      v: 2,
      mesh: "-",
      type: "found",
      by: pub(founder),
      n: 1,
      prev: [],
      subject: { card: card(founder, machines[0] ?? "", "-", "-") },
    },
    founder.sign.secretKey,
  );
  const mesh = meshIdOf(found);
  const records: Signed[] = [found];
  const admit = (who: Identity, name: string, client: boolean) => {
    const prev = records.at(-1);
    if (prev === undefined) throw new Error("no record to follow");
    const subject = { card: card(who, name, mesh, pub(founder), client) };
    const n = records.length + 1;
    const body = { v: 2, mesh, type: "admit", by: pub(founder), n, prev: [hashOf(prev)], subject } as const;
    records.push(signRecord(body, founder.sign.secretKey));
  };
  hosts.slice(1).forEach((host, index) => admit(host, machines[index + 1] ?? "", false));
  admit(browser, browserName, true);
  const membership: BrowserMembership = {
    meshId: mesh,
    records,
    signPub: pub(browser),
    inviter: { hostId: founder.hostId, hostKey: base64urlEncode(founder.noise.publicKey) },
    relayUrl: "wss://relay.example",
    joinedAt: "2026-11-26T00:00:00.000Z",
  };
  return {
    membership,
    hostIds: hosts.map((host) => host.hostId),
    keys: { signPub: pub(browser), devicePub: base64urlEncode(browser.noise.publicKey) },
    secrets: { sign: browser.sign.secretKey, device: browser.noise.secretKey },
  };
}

export type MeshFixture = ReturnType<typeof meshFixture>;

/** The fixture with its browser holding `pair` as its device key, public half included (a key a test host paired). */
export const withDevice = (
  mesh: MeshFixture,
  pair: { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array },
): MeshFixture => ({
  ...mesh,
  keys: { ...mesh.keys, devicePub: base64urlEncode(pair.publicKey) },
  secrets: { ...mesh.secrets, device: pair.secretKey },
});

const slotKey = (slot: string, key: string): string => (slot === DEFAULT_SLOT ? key : `mesh-identity/${slot}/${key}`);

/** Puts a fixture's browser in `storage` on `slot` as a join would leave it: keys stored, membership written. */
export async function joinedStore(
  storage: KeyValueStore,
  fixture: MeshFixture,
  slot: string,
): Promise<MembershipStore> {
  const store = new MembershipStore(storage, fixture.keys, slot);
  await store.enroll(`fixture-${slot}`);
  await storage.put(slotKey(slot, "mesh-sign-key"), { kind: "raw", privateKey: fixture.secrets.sign });
  await storage.put(slotKey(slot, "device-key"), { kind: "raw", privateKey: fixture.secrets.device });
  await store.adopt(fixture.membership);
  return store;
}
