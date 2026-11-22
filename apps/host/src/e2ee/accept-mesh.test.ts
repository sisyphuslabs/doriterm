import { CloseCode, generateX25519, pairingSlotOf, rawStaticKey } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signCard } from "@doriface/mesh";
import { cardBody } from "../state/mesh.ts";
import { deviceOf, type Machine, machine, MeshFixture, signPubOf } from "../testing/mesh-history.ts";
import { codeOf, linkOf, pairingHost, type PairingHost, runSession } from "../testing/pairing-harness.ts";
import { spendMeshOffer } from "./accept.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Meshed {
  readonly host: PairingHost;
  readonly mesh: MeshFixture;
  readonly founder: Machine;
  readonly member: Machine;
  readonly revoked: Machine;
}

/** A host whose mesh has a founder, a current member, and a member that was admitted and then revoked. */
function meshed(meshOffer = false): Meshed {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-accept-"));
  dirs.push(dir);
  const [founder, member, revoked] = [machine("founder"), machine("member"), machine("gone")];
  const mesh = new MeshFixture(dir, founder);
  mesh.admit(founder, member);
  mesh.admit(founder, revoked);
  mesh.revoke(founder, revoked);
  return { host: pairingHost({ dir, meshOffer, mesh: () => mesh.store }), mesh, founder, member, revoked };
}

const keyOf = (m: Machine) => rawStaticKey(m.identity.noise);

/** A newer mesh offer on another slot than the one the session was opened for (a draw may repeat a slot). */
function replaceOffer(host: PairingHost): void {
  const opened = pairingSlotOf(host.offer.code);
  while (pairingSlotOf(host.pairing.offer(Date.now(), true).code) === opened);
}

async function outcome(run: ReturnType<typeof runSession>) {
  const secure = await run.host;
  await run.client;
  return secure === undefined ? { code: run.hostEnd.closeCode, sent: run.hostEnd.sent.length } : "accepted";
}

describe("H-1: section 9.2's authorization table", () => {
  test.each([
    ["a member's hc line (stream absent)", undefined],
    ['a member\'s hc line (stream "hc")', "hc"],
    ["a member's sync session (stream mesh)", "mesh"],
  ] as const)("%s is accepted", async (_, stream) => {
    const { host, member } = meshed();
    expect(await outcome(runSession(host, { kind: "lan" }, undefined, { staticKey: keyOf(member), stream }))).toBe(
      "accepted",
    );
  });

  test.each([
    ["hc line", undefined],
    ["sync session", "mesh"],
  ] as const)("a revoked member's %s is refused 4401 unanswered", async (_, stream) => {
    const { host, revoked } = meshed();
    const run = runSession(host, { kind: "lan" }, undefined, { staticKey: keyOf(revoked), stream });
    expect(await outcome(run)).toEqual({ code: CloseCode.UnknownDevice, sent: 0 });
    expect(host.logs).toContain(
      `e2ee: close code=4401 source=handshake kind=1 stream=${stream ?? "hc"}: revoked mesh member`,
    );
  });

  test("a revoked member's key is refused even after a device entry for it was added", async () => {
    const { host, revoked } = meshed();
    host.deps.devices.add(revoked.identity.noise.publicKey, "sneaked in");
    const run = runSession(host, { kind: "lan" }, undefined, { staticKey: keyOf(revoked) });
    expect(await outcome(run)).toEqual({ code: CloseCode.UnknownDevice, sent: 0 });
  });

  test("a paired device is accepted on the hc stream and refused on the mesh stream", async () => {
    const { host } = meshed();
    const phone = generateX25519();
    host.deps.devices.add(phone.publicKey, "phone");
    const hc = runSession(host, { kind: "lan" }, undefined, { staticKey: rawStaticKey(phone) });
    expect(await outcome(hc)).toBe("accepted");
    const sync = runSession(host, { kind: "lan" }, undefined, { staticKey: rawStaticKey(phone), stream: "mesh" });
    expect(await outcome(sync)).toEqual({ code: CloseCode.UnknownDevice, sent: 0 });
  });

  test("the push stream admits a paired device and refuses a member and an outsider, unanswered", async () => {
    const { host, member } = meshed();
    const phone = generateX25519();
    host.deps.devices.add(phone.publicKey, "phone");
    const push = (staticKey: ReturnType<typeof rawStaticKey>) =>
      outcome(runSession(host, { kind: "lan" }, undefined, { staticKey, stream: "push" }));
    const refused = { code: CloseCode.UnknownDevice, sent: 0 };
    expect(await push(rawStaticKey(phone))).toBe("accepted");
    expect(await push(keyOf(member))).toEqual(refused);
    expect(await push(rawStaticKey(generateX25519()))).toEqual(refused);
    expect(host.logs).toContain(
      "e2ee: close code=4401 source=handshake kind=1 stream=push: a mesh member has no push stream",
    );
  });

  test("a device presenting a member's device key is refused 4401 even with a devices.json entry", async () => {
    const { host, member } = meshed();
    host.deps.devices.add(member.device.publicKey, "member's laptop");
    const run = runSession(host, { kind: "lan" }, undefined, { staticKey: rawStaticKey(member.device) });
    expect(await outcome(run)).toEqual({ code: CloseCode.UnknownDevice, sent: 0 });
    expect(host.logs).toContain(
      "e2ee: close code=4401 source=handshake kind=1 stream=hc: this key belongs to a mesh member: use the mesh line",
    );
  });

  test("an outsider is refused on both streams", async () => {
    const { host } = meshed();
    const refused = { code: CloseCode.UnknownDevice, sent: 0 };
    const runs = ([undefined, "mesh"] as const).map((stream) =>
      outcome(runSession(host, { kind: "lan" }, undefined, { staticKey: rawStaticKey(generateX25519()), stream })),
    );
    expect(await Promise.all(runs)).toEqual([refused, refused]);
  });
});

describe("H-1: pairing kinds against the offer's kind", () => {
  test("a machine join on a device offer is refused 4401 unanswered, and the offer stays", async () => {
    const { host } = meshed(false);
    const run = runSession(host, { kind: "lan" }, linkOf(host, "laptop"), { stream: "mesh" });
    expect(await outcome(run)).toEqual({ code: CloseCode.UnknownDevice, sent: 0 });
    expect(host.pairing.read()).toBeDefined();
  });

  test("a device pairing on a mesh offer is refused 4401 unanswered, and stores no device", async () => {
    const { host } = meshed(true);
    const run = runSession(host, { kind: "lan" }, linkOf(host, "phone"));
    expect(await outcome(run)).toEqual({ code: CloseCode.UnknownDevice, sent: 0 });
    expect(host.deps.devices.list()).toEqual([]);
  });

  test("a typed-code machine join on a device offer is refused 4401 unanswered: the joiner pairs as a device instead", async () => {
    const { host } = meshed(false);
    const run = runSession(host, host.relay, codeOf(host, "laptop"), { stream: "mesh" });
    expect(await outcome(run)).toEqual({ code: CloseCode.UnknownDevice, sent: 0 });
    expect(host.pairing.read()?.codeAttempts).toBe(0);
  });

  test.each([
    ["replaced by a newer mesh offer", replaceOffer],
    ["expired", (host: PairingHost) => host.pairing.offer(Date.now() - 24 * 60 * 60 * 1000, true)],
    ["gone, with no offer pending", (host: PairingHost) => host.pairing.expire(Number.MAX_SAFE_INTEGER)],
  ])(
    "a typed-code machine join on a mesh offer %s is refused 4411, not as a device offer (#1492)",
    async (_, change) => {
      const { host } = meshed(true);
      change(host);
      const run = runSession(host, host.relay, codeOf(host, "laptop"), { stream: "mesh" });
      expect(await outcome(run)).toEqual({ code: CloseCode.MeshCodeRefused, sent: 0 });
      // The refusal is on the host's record, as a 4401 refusal was before the remap (review of #1733).
      expect(
        host.logs.some((line) => line.startsWith("e2ee: close code=4411 source=handshake kind=2 stream=mesh: ")),
      ).toBe(true);
    },
  );

  test("a mesh handshake reserves its offer until the first card spends it once, and stores no device", async () => {
    const { host } = meshed(true);
    const run = runSession(host, { kind: "lan" }, linkOf(host, "laptop"), { stream: "mesh" });
    const secure = await run.host;
    expect(secure?.stream).toBe("mesh");
    if (secure === undefined) throw new Error("the mesh handshake was refused");
    expect(host.pairing.read()).toBeDefined();
    expect(spendMeshOffer(secure)).toBe(true);
    expect(spendMeshOffer(secure)).toBe(false);
    expect(host.pairing.read()).toBeUndefined();
    expect(host.deps.devices.list()).toEqual([]);
  });
});

describe("H-5: admitPairing refuses a mesh member's keys", () => {
  test.each([
    ["a current member's Noise key", (m: Meshed) => m.member.identity.noise],
    ["a current member's device key", (m: Meshed) => m.member.device],
    ["a revoked member's Noise key", (m: Meshed) => m.revoked.identity.noise],
  ])("pairing with %s stores no device and closes 4401", async (_, keyFor) => {
    const meshedHost = meshed(false);
    const { host } = meshedHost;
    const run = runSession(host, { kind: "lan" }, linkOf(host), { staticKey: rawStaticKey(keyFor(meshedHost)) });
    expect(await run.host).toBeUndefined();
    await run.client;
    expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(host.deps.devices.list()).toEqual([]);
    expect(host.logs).toContain("e2ee: close code=4401 source=pairing-admission: this key belongs to a mesh member");
  });
});

describe("a client's own push association", () => {
  test("pairing with a client member's session key is accepted, since that key is its own push identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-mesh-client-accept-"));
    dirs.push(dir);
    const [founder, phone] = [machine("founder"), machine("phone")];
    const mesh = new MeshFixture(dir, founder);
    const own = { name: phone.name, hcId: phone.hcId, devicePub: deviceOf(phone) };
    // A browser's session key is its device key (design 4.1), so the joining identity presents the device key as noise.
    const session = { ...phone.identity, noise: phone.device };
    const card = signCard(
      cardBody(session, own, mesh.meshId, signPubOf(founder), undefined, "client"),
      phone.identity.sign.secretKey,
    );
    mesh.record(founder, "admit", { card });
    expect(mesh.store.authorizeIndex()?.client(deviceOf(phone))?.name).toBe("phone");

    const host = pairingHost({ dir, meshOffer: false, mesh: () => mesh.store });
    const run = runSession(host, { kind: "lan" }, linkOf(host), { staticKey: rawStaticKey(phone.device) });
    expect(await run.host).toBeDefined();
    await run.client;
    expect(host.deps.devices.list().map((device) => device.clientStaticPub)).toContain(deviceOf(phone));
  });
});
