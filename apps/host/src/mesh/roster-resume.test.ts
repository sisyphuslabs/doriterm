import { base64urlDecode } from "@doriface/crypto";
import { signCard } from "@doriface/mesh";
import { joinCode, joinCommit, MeshLines } from "@doriface/mesh/join";
import { parsePolicy } from "@doriface/policy";
import { afterEach, expect, spyOn, test } from "bun:test";
import { cardBody } from "../state/mesh.ts";
import { side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { clearRosterResumes, fixture, open, required, droppedJoin, resume } from "../testing/roster-resume-harness.ts";
afterEach(clearRosterResumes);

test("a drop before reveal resumes on authenticated roster with the original code and admits once", async () => {
  const f = await droppedJoin();
  expect(f.pairing.read()).toBeUndefined();
  const { client, first } = await resume(f, f.pending.nonce);
  if (first.t !== "reveal") throw new Error("no resumed reveal");
  const Ni = base64urlDecode(first.Ni);
  expect(joinCommit(f.h, Ni)).toBe(f.offer.commit ?? "");
  expect(joinCode(f.h, Ni, f.Nj)).toBe(f.pending.code);
  f.host.pending.decide(f.pending.nonce, true, f.pending.code);
  expect(f.a.mesh.read()?.records).toHaveLength(1);
  client.send({ t: "confirm" });
  expect((await client.next()).t).toBe("records");
  expect((await client.next()).t).toBe("done");
  expect(f.a.mesh.read()?.records).toHaveLength(2);
  const refresh = await resume(f, f.pending.nonce);
  expect(refresh.first.t).toBe("records");
  expect((await refresh.client.next()).t).toBe("done");
  expect(f.a.mesh.read()?.records).toHaveLength(2);
});

test("a different authenticated key cannot resume and a wrong nonce cannot consume the pending join", async () => {
  const f = await droppedJoin();
  const wrongKey = await open(f, "roster", side("stranger"));
  expect(wrongKey.host).toBeUndefined();
  const wrongNonce = await resume(f, "another-nonce");
  expect(wrongNonce.first).toEqual({ t: "refused", reason: "Ask for a new invite" });
  expect(f.host.pending.list()).toHaveLength(1);
  expect(f.a.mesh.read()?.records).toHaveLength(1);
});

test.each(["denied", "expired"] as const)("a %s pending join cannot reopen a roster session", async (state) => {
  const f = await droppedJoin();
  const retained = f.host.resumes.get(f.pending.nonce, noiseOf(f.c.m));
  if (retained === undefined) throw new Error("no retained join");
  if (state === "denied") {
    f.host.pending.decide(f.pending.nonce, false);
    await retained.welcome.catch(() => undefined);
  }
  const clock = state === "expired" ? spyOn(Date, "now").mockReturnValue(f.pending.expiresAt + 1) : undefined;
  try {
    const again = await open(f, "roster");
    expect(again.host).toBeUndefined();
    expect(f.a.mesh.read()?.records).toHaveLength(1);
  } finally {
    clock?.mockRestore();
  }
});

test("a full paired-device budget does not reject a machine before its card is known", async () => {
  const f = fixture();
  await f.host.pair(true);
  f.devices.add(side("phone").m.identity.noise.publicKey, "phone");
  const limited = { ...f, deps: { ...f.deps, policy: parsePolicy('{"limits":{"devices":1,"machines":2}}') } };
  const dial = await open(limited, "pair", side("machine"));
  expect(dial.host?.stream).toBe("mesh");
  expect(f.pairing.read()).toBeDefined();
});

test("an admit completed after its session dropped still sweeps unpaired roster clients", async () => {
  const f = await droppedJoin();
  const old = side("old-browser");
  f.devices.add(old.m.identity.noise.publicKey, "old-browser");
  const dial = await open(f, "roster", old);
  const client = new MeshLines(required(dial.joined), ["offer", "records", "done", "refused"]);
  f.host.roster(required(dial.host));
  const offer = await client.next();
  if (offer.t !== "offer") throw new Error("no roster offer");
  client.send({
    t: "card",
    ...signCard(
      cardBody(
        old.m.identity,
        {
          name: "old-browser",
          hcId: "",
          devicePub: noiseOf(old.m),
        },
        offer.mesh,
        offer.inviter,
        offer.nonce,
        "client",
      ),
      old.m.identity.sign.secretKey,
    ),
  });
  expect((await client.next()).t).toBe("records");
  expect((await client.next()).t).toBe("done");
  f.devices.revoke(noiseOf(old.m));
  const retained = f.host.resumes.get(f.pending.nonce, noiseOf(f.c.m));
  if (retained === undefined) throw new Error("no retained join");
  f.host.pending.confirm(f.pending.nonce);
  f.host.pending.decide(f.pending.nonce, true, f.pending.code);
  await retained.welcome;
  expect(f.a.mesh.authorizeIndex()?.client(noiseOf(old.m))).toBeUndefined();
  expect(f.a.mesh.authorizeIndex()?.client(noiseOf(f.c.m))).toBeDefined();
});

test("an admitted resume anchor cannot reopen roster after the admitting machine leaves", async () => {
  const f = await droppedJoin();
  const retained = f.host.resumes.get(f.pending.nonce, noiseOf(f.c.m));
  if (retained === undefined) throw new Error("no retained join");
  f.host.pending.confirm(f.pending.nonce);
  f.host.pending.decide(f.pending.nonce, true, f.pending.code);
  await retained.welcome;
  f.a.mesh.sign(f.a.m.identity, (n, prev) => ({
    v: 2,
    mesh: f.offer.mesh,
    type: "revoke",
    by: signPubOf(f.a.m),
    n,
    prev,
    subject: { signPubs: [signPubOf(f.a.m)], reason: "leave" },
  }));
  const orphan = await open(f, "roster");
  expect(orphan.host).toBeUndefined();
});
