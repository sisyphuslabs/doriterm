import { base64urlEncode, SessionKind } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { parseRecord, signCard, verifyCard } from "@doriface/mesh";
import { JOINER_EXPECTS, MeshLines, ROSTER_EXPECTS } from "@doriface/mesh/join";
import { OPEN_POLICY } from "@doriface/policy";
import { afterEach, expect, test } from "bun:test";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { removeSides, side, ownOf } from "../testing/join-harness.ts";
import { cardFor, noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { isRejoin } from "./admission.ts";
import { serveRoster } from "./roster.ts";
import { failure } from "../testing/join-harness.ts";
import { sessionPeer } from "../e2ee/authorize.ts";
import { LiveSessions } from "../e2ee/sessions.ts";

afterEach(removeSides);

function family() {
  const a = side("alpha");
  const b = side("beta");
  const c = side("browser");
  a.mesh.found(a.m.identity, ownOf(a));
  const mesh = a.mesh.read()?.meshId ?? "";
  const machineCard = cardFor(b.m, mesh, a.m);
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "admit",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { card: machineCard },
  }));
  const body = cardBody(
    c.m.identity,
    { name: "browser", hcId: "", devicePub: noiseOf(c.m) },
    mesh,
    signPubOf(a.m),
    undefined,
    "client",
  );
  const signed = signCard(body, c.m.identity.sign.secretKey);
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "admit",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { card: signed },
  }));
  return { a, b, c, body, mesh };
}

test("revoking the admitting machine removes its client from the real persisted index", () => {
  const { a, c, mesh } = family();
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))?.signPub).toBe(signPubOf(c.m));
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "revoke",
    by: signPubOf(a.m),
    n,
    prev,
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

test("a client cannot take another signing member's current device key", () => {
  const { a, b, body } = family();
  const signed = signCard(
    { ...body, hostId: b.m.identity.hostId, signPub: signPubOf(b.m) },
    b.m.identity.sign.secretKey,
  );
  const card = verifyCard(signed);
  if (card === undefined) throw new Error("the client card did not verify");
  expect(() => isRejoin(a.mesh.authorizeIndex(), card, a.mesh.read()?.records ?? [])).toThrow(
    "this Noise key is another mesh member's",
  );
});

test("a current client cannot refresh its signing membership with another device key", () => {
  const { a, c, body } = family();
  const other = side("other-device");
  const signed = signCard(
    { ...body, noisePub: noiseOf(other.m), devicePub: noiseOf(other.m) },
    c.m.identity.sign.secretKey,
  );
  const card = verifyCard(signed);
  if (card === undefined) throw new Error("the client card did not verify");
  expect(() => isRejoin(a.mesh.authorizeIndex(), card, a.mesh.read()?.records ?? [])).toThrow(
    "this host is a member with another Noise key",
  );
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
  expect(() =>
    isRejoin(
      a.mesh.authorizeIndex(),
      { ...body, noisePub: different, devicePub: different },
      a.mesh.read()?.records ?? [],
    ),
  ).toThrow("another Noise key");
});

test.each(["revoke", "orphan"] as const)(
  "a %s client can never acquire another admit with its old signing key",
  (mode) => {
    const { a, b, c, body, mesh } = family();
    a.mesh.sign(a.m.identity, (n, prev) => ({
      v: 2,
      mesh,
      type: "revoke",
      by: signPubOf(a.m),
      n,
      prev,
      subject: { signPubs: [mode === "orphan" ? signPubOf(a.m) : signPubOf(c.m)], reason: "revoke" },
    }));
    b.mesh.adopt(a.mesh.read()?.records ?? [], b.m.identity);
    new DeviceStore(b.dir).add(c.m.identity.noise.publicKey, "browser");
    const records = b.mesh.read()?.records ?? [];
    expect(() => isRejoin(b.mesh.authorizeIndex(), body, records)).toThrow("this browser was removed");
    expect(records.filter((r) => parseRecord(r)?.type === "admit")).toHaveLength(2);
    expect(verifyCard(signCard(body, c.m.identity.sign.secretKey))?.kind).toBe("client");
  },
);

test("an orphan keeps only its original pairing and repeated roster retries cannot readmit its signing key", async () => {
  const { a, b, c, mesh } = family();
  const devices = new DeviceStore(b.dir);
  devices.add(c.m.identity.noise.publicKey, "browser");
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "revoke",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { signPubs: [signPubOf(a.m)], reason: "revoke" },
  }));
  b.mesh.adopt(a.mesh.read()?.records ?? [], b.m.identity);
  expect(sessionPeer(undefined, c.m.identity.noise.publicKey, b.mesh.authorizeIndex(), devices).kind).toBe("device");
  expect(
    sessionPeer(undefined, c.m.identity.noise.publicKey, b.mesh.authorizeIndex(), new DeviceStore(a.dir)).kind,
  ).toBe("refused");
  const before = b.mesh.read()?.records.length ?? 0;
  const roster = async (joiner: ReturnType<typeof side>) => {
    const [hostEnd, clientEnd] = memoryLinkPair(true);
    const client = new MeshLines(clientEnd, JOINER_EXPECTS);
    const served = failure(
      serveRoster(new MeshLines(hostEnd, ROSTER_EXPECTS), joiner.m.identity.noise.publicKey, {
        identity: b.m.identity,
        mesh: b.mesh,
        devices,
        stateDir: b.dir,
        policy: OPEN_POLICY,
        formatReady: () => true,
        floor: () => undefined,
        log: () => {},
      }),
    );
    const offer = await client.next();
    if (offer.t !== "offer") throw new Error("no roster offer");
    client.expect("records", "done", "refused");
    client.send({
      t: "card",
      ...signCard(
        cardBody(
          joiner.m.identity,
          {
            name: joiner.m.name,
            hcId: "",
            devicePub: noiseOf(joiner.m),
          },
          offer.mesh,
          offer.inviter,
          offer.nonce,
          "client",
        ),
        joiner.m.identity.sign.secretKey,
      ),
    });
    return served;
  };
  expect(await roster(c)).toContain("join again with an invite");
  expect(await roster(c)).toContain("join again with an invite");
  expect(b.mesh.read()?.records).toHaveLength(before);
  const fresh = side("fresh-browser");
  devices.add(fresh.m.identity.noise.publicKey, "fresh-browser");
  expect(await roster(fresh)).toBe("resolved");
  expect(b.mesh.read()?.records).toHaveLength(before + 1);
});

test.each(["client", "admitter"] as const)("revoking the %s closes the client's three live stream kinds", (target) => {
  const { a, c, mesh } = family();
  const sessions = new LiveSessions(new DeviceStore(a.dir), () => {}, a.mesh);
  const links = ([undefined, "push", "roster"] as const).map((stream) => {
    const [link] = memoryLinkPair(true);
    sessions.add(
      Object.assign(link, {
        kind: SessionKind.Session,
        remoteStatic: c.m.identity.noise.publicKey,
        handshakeHash: new Uint8Array(32),
        peerName: "",
        lanUrls: [],
        stream,
      }),
    );
    return link;
  });
  expect(sessions.count()).toBe(3);
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "revoke",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { signPubs: [signPubOf(target === "client" ? c.m : a.m)], reason: "revoke" },
  }));
  sessions.closeRevoked();
  expect(sessions.count()).toBe(0);
  expect(links.map((link) => link.closeCode)).toEqual([4401, 4401, 4401]);
});
