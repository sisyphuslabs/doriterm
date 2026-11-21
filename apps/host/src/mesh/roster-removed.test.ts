import { base64urlEncode, CloseCode } from "@doriface/crypto";
import { nextClose } from "@doriface/crypto/testing";
import { parseRecord, type Signed, signCard } from "@doriface/mesh";
import { MeshLines } from "@doriface/mesh/join";
import { afterEach, expect, test } from "bun:test";
import { sessionPeer } from "../e2ee/authorize.ts";
import { cardBody } from "../state/mesh.ts";
import { REMOVED_READING } from "./roster-removal.ts";
import { clearPropagation, roster } from "../testing/client-propagation-harness.ts";
import { side, type Side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { fixture, open, required } from "../testing/roster-resume-harness.ts";

afterEach(clearPropagation);

/** A browser admitted on the roster, removed the way `mesh revoke` on a machine removes it, then a later admission. */
async function removedBrowser() {
  const f = fixture();
  f.devices.add(f.c.m.identity.noise.publicKey, "browser");
  await roster(f);
  const mesh = f.a.mesh.read()?.meshId ?? "";
  const by = signPubOf(f.a.m);
  f.a.mesh.sign(f.a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "revoke",
    by,
    n,
    prev,
    subject: { signPubs: [signPubOf(f.c.m)], reason: "revoke" },
  }));
  const later = side("later-browser");
  f.devices.add(later.m.identity.noise.publicKey, "later");
  await roster(f, later);
  return f;
}

type Offer = { readonly mesh: string; readonly inviter: string; readonly nonce: string };
type Line = Parameters<MeshLines["send"]>[0];

async function rosterReply(f: ReturnType<typeof fixture>, client: Side, reply: (offer: Offer) => Line) {
  const dial = await open(f, "roster", client);
  const lines = new MeshLines(required(dial.joined), ["offer", "records", "done", "refused"]);
  f.host.roster(required(dial.host));
  const offer = await lines.next();
  if (offer.t !== "offer") throw new Error("no roster offer");
  lines.send(reply(offer));
  const records: Signed[] = [];
  const receive = async (): ReturnType<MeshLines["next"]> => {
    const line = await lines.next();
    if (line.t !== "records") return line;
    records.push(...line.records);
    return receive();
  };
  const end = await receive();
  return { records, end };
}

const ownCard =
  (client: Side, signer: Side = client) =>
  (offer: Offer): Line => ({
    t: "card",
    ...signCard(
      cardBody(
        { ...signer.m.identity, noise: client.m.identity.noise },
        { name: client.m.name, hcId: "", devicePub: noiseOf(client.m) },
        offer.mesh,
        offer.inviter,
        offer.nonce,
        "client",
      ),
      signer.m.identity.sign.secretKey,
    ),
  });

const types = (records: readonly Signed[]) => records.map((record) => parseRecord(record)?.type);

test("a removed browser reads the records up to its removal, and nothing signed after it", async () => {
  const f = await removedBrowser();
  const before = f.a.mesh.read()?.records ?? [];
  const { records, end } = await rosterReply(f, f.c, ownCard(f.c));
  expect(end.t).toBe("done");
  expect(types(records)).toEqual(["found", "admit", "revoke"]);
  expect(types(before)).toEqual(["found", "admit", "revoke", "admit"]);
  expect(f.a.mesh.read()?.records).toEqual(before);
  expect(f.a.mesh.authorizeIndex()?.client(noiseOf(f.c.m))).toBeUndefined();
});

test("a removed browser's key opens no other stream", async () => {
  const f = await removedBrowser();
  const index = f.a.mesh.authorizeIndex();
  for (const stream of [undefined, "hc", "push", "mesh"] as const) {
    expect(sessionPeer(stream, f.c.m.identity.noise.publicKey, index, f.devices).kind).toBe("refused");
  }
  expect(index?.removed(base64urlEncode(f.c.m.identity.noise.publicKey), signPubOf(f.c.m))).toBe(true);
});

test("a card under another signing key on a removed browser's key reads nothing", async () => {
  const f = await removedBrowser();
  const { records, end } = await rosterReply(f, f.c, ownCard(f.c, side("stranger")));
  expect(records).toEqual([]);
  expect(end.t).toBe("refused");
});

test("a removed key holds one roster session at a time, and its slot frees when that session ends", async () => {
  const f = await removedBrowser();
  const first = await open(f, "roster", f.c);
  const host = required(first.host);
  const ended = new Promise<void>((resolve) => host.onClose(() => resolve()));
  const lines = new MeshLines(required(first.joined), ["offer", "records", "done", "refused"]);
  f.host.roster(host);
  const offer = await lines.next();
  if (offer.t !== "offer") throw new Error("no roster offer");
  const extra = await Promise.all(Array.from({ length: 4 }, () => open(f, "roster", f.c)));
  for (const dial of extra) if (dial.host !== undefined) f.host.roster(dial.host);
  expect(extra.map((dial) => dial.host === undefined)).toEqual([true, true, true, true]);
  for (const dial of extra) {
    expect(dial.hostEnd.closeCode).toBe(CloseCode.RateLimited);
    expect(dial.refusal).toMatchObject({ code: CloseCode.RateLimited, cause: { message: REMOVED_READING } });
  }
  lines.send(ownCard(f.c)(offer));
  await ended;
  const again = await open(f, "roster", f.c);
  expect(again.host).toBeDefined();
});

test("of two roster sessions a removed key got past the handshake with, the later is closed and the slot stays held", async () => {
  const f = await removedBrowser();
  const key = base64urlEncode(f.c.m.identity.noise.publicKey);
  const [first, later] = await Promise.all([open(f, "roster", f.c), open(f, "roster", f.c)]);
  const host = required(first.host);
  const ended = new Promise<void>((resolve) => host.onClose(() => resolve()));
  const lines = new MeshLines(required(first.joined), ["offer", "records", "done", "refused"]);
  f.host.roster(host);
  const offer = await lines.next();
  if (offer.t !== "offer") throw new Error("no roster offer");
  const closed = nextClose(required(later.joined));
  f.host.roster(required(later.host));
  expect(await closed).toMatchObject({ code: CloseCode.RateLimited, message: REMOVED_READING });
  expect(later.hostEnd.closeCode).toBe(CloseCode.RateLimited);
  expect(f.host.removedRosterHeld(key)).toBe(true);
  lines.send(ownCard(f.c)(offer));
  await ended;
  expect(f.host.removedRosterHeld(key)).toBe(false);
  const again = await open(f, "roster", f.c);
  expect(again.host).toBeDefined();
});

test("a removed browser cannot resume a join", async () => {
  const f = await removedBrowser();
  const { records, end } = await rosterReply(f, f.c, (): Line => ({ t: "resume", nonce: "AAAAAAAAAAAAAAAAAAAAAA" }));
  expect(records).toEqual([]);
  expect(end.t).toBe("refused");
});
