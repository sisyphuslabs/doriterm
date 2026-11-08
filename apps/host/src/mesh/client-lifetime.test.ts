import { base64urlEncode } from "@doriface/crypto";
import { parseRecord, signCard, verifyCard } from "@doriface/mesh";
import { afterEach, expect, test } from "bun:test";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { removeSides, side, ownOf } from "../testing/join-harness.ts";
import { cardFor, noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { isRejoin } from "./admission.ts";

afterEach(removeSides);

function family() {
  const a = side("alpha");
  const b = side("beta");
  const c = side("browser");
  a.mesh.found(a.m.identity, ownOf(a));
  const mesh = a.mesh.read()?.meshId ?? "";
  const machineCard = cardFor(b.m, mesh, a.m);
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2, mesh, type: "admit", by: signPubOf(a.m), n, prev, subject: { card: machineCard },
  }));
  const body = cardBody(c.m.identity, { name: "browser", hcId: "", devicePub: noiseOf(c.m) }, mesh, signPubOf(a.m), undefined, "client");
  const signed = signCard(body, c.m.identity.sign.secretKey);
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2, mesh, type: "admit", by: signPubOf(a.m), n, prev, subject: { card: signed },
  }));
  return { a, b, c, body, mesh };
}

test("revoking the admitting machine removes its client from the real persisted index", () => {
  const { a, c, mesh } = family();
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))?.signPub).toBe(signPubOf(c.m));
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2, mesh, type: "revoke", by: signPubOf(a.m), n, prev,
    subject: { signPubs: [signPubOf(a.m)], reason: "leave" },
  }));
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))).toBeUndefined();
});

test("machineCount excludes client members without losing their signing membership", () => {
  const { a, c } = family();
  const index = a.mesh.authorizeIndex();
  expect(index?.machineCount).toBe(2);
  expect(index?.isMember(signPubOf(c.m))).toBe(true);
});

test("a current client's same signing and device keys refresh instead of ANOTHER_KEY", () => {
  const { a, body } = family();
  expect(isRejoin(a.mesh.authorizeIndex(), body, a.mesh.read()?.records ?? [])).toBe(true);
});

test("another signer holding a client's key is refused", () => {
  const { a, c, body } = family();
  const twin = side("twin");
  const card = { ...body, signPub: signPubOf(twin.m), hostId: twin.m.identity.hostId };
  expect(() => isRejoin(a.mesh.authorizeIndex(), card, a.mesh.read()?.records ?? [])).toThrow("another mesh member");
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))?.name).toBe("browser");
});

test("a client's signing key with a different device key is refused", () => {
  const { a, body } = family();
  const different = base64urlEncode(new Uint8Array(32).fill(23));
  expect(() => isRejoin(a.mesh.authorizeIndex(), { ...body, noisePub: different, devicePub: different }, a.mesh.read()?.records ?? [])).toThrow("another Noise key");
});

test.each(["revoke", "orphan"] as const)("a %s client can never acquire another admit with its old signing key", (mode) => {
  const { a, b, c, body, mesh } = family();
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2, mesh, type: "revoke", by: signPubOf(a.m), n, prev,
    subject: { signPubs: [mode === "orphan" ? signPubOf(a.m) : signPubOf(c.m)], reason: "revoke" },
  }));
  b.mesh.adopt(a.mesh.read()?.records ?? [], b.m.identity);
  new DeviceStore(b.dir).add(c.m.identity.noise.publicKey, "browser");
  const records = b.mesh.read()?.records ?? [];
  expect(() => isRejoin(b.mesh.authorizeIndex(), body, records)).toThrow("this browser was removed");
  expect(records.filter((r) => parseRecord(r)?.type === "admit")).toHaveLength(2);
  expect(verifyCard(signCard(body, c.m.identity.sign.secretKey))?.kind).toBe("client");
});
