import { CloseCode, generateX25519 } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { parseRecord, type Signed, signCard, signRecord } from "@doriface/mesh";
import { afterEach, describe, expect, test } from "bun:test";
import { cardBody } from "../state/mesh.ts";
import {
  failure,
  inviteDeps,
  joinerContext,
  ownOf,
  removeSides,
  runJoin,
  side,
  type Side,
} from "../testing/join-harness.ts";
import { signPubOf } from "../testing/mesh-history.ts";
import { runJoiner } from "./join.ts";
import { INVITER_EXPECTS, JOINER_EXPECTS, MeshLines } from "./lines.ts";
import { PendingJoins } from "./pending-joins.ts";

afterEach(removeSides);

const records = (s: Side): readonly Signed[] => s.mesh.read()?.records ?? [];
const autoJoins = (): PendingJoins => {
  const pending = new PendingJoins();
  pending.setAuto(Date.now() + 60_000);
  return pending;
};

describe("J-1: offer, card, approval, welcome, done", () => {
  test("both mesh.json files hold the same records, the joiner is a member admitted by the inviter, and the session stays open", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const run = runJoin(inviteDeps(a, autoJoins()), joinerContext(b, a), b.m.identity.noise.publicKey);
    expect(await run.joined).toBe(a.mesh.read()?.meshId ?? "");
    await run.invited;
    expect(records(b)).toEqual(records(a));
    expect(records(a).map((record) => parseRecord(record)?.type)).toEqual(["found", "admit"]);
    const index = b.mesh.authorizeIndex();
    expect(index?.member(noise(b))?.name).toBe("beta");
    expect(index?.member(noise(a))?.hcId).toBe(a.m.hcId);
    expect([run.inviterEnd.closeCode, run.joinerEnd.closeCode]).toEqual([undefined, undefined]);
  });

  test("a welcome larger than one line arrives in several lines of at most 256 KiB", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    a.mesh.found(a.m.identity, ownOf(a));
    const meshId = a.mesh.read()?.meshId ?? "";
    const acks: Signed[] = [];
    const at = `2026-11-03T00:00:00Z ${"x".repeat(1500)}`;
    for (let n = 2; n <= 160; n++) {
      const last = acks.at(-1) ?? records(a)[0];
      const body = { v: 2, mesh: meshId, type: "ack", by: signPubOf(a.m), n, prev: [hashOfSigned(last)], at } as const;
      acks.push(signRecord(body, a.m.identity.sign.secretKey));
    }
    a.mesh.merge(acks);
    a.mesh.catchUp(a.m.identity);
    const run = runJoin(inviteDeps(a, autoJoins()), joinerContext(b, a), b.m.identity.noise.publicKey);
    await run.joined;
    const lines = run.inviterEnd.sent.map((bytes) => new TextDecoder().decode(bytes));
    const recordLines = lines.filter((line) => line.startsWith('{"t":"records"'));
    expect(recordLines.length).toBeGreaterThan(1);
    expect(Math.max(...recordLines.map((line) => new TextEncoder().encode(line).byteLength))).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(records(b)).toHaveLength(records(a).length);
  }, 30_000);
});

describe("J-3: the inviting member's confirmation", () => {
  test("nothing is admitted until the member approves; then the joiner is in", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const pending = new PendingJoins();
    const run = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    const asked = await pending.next();
    expect([asked.name, asked.hostId]).toEqual(["beta", b.m.identity.hostId]);
    expect(records(a).map((record) => parseRecord(record)?.type)).toEqual(["found"]);
    expect(pending.decide(asked.nonce, true, asked.code)).toBe(true);
    expect(await run.joined).toBe(a.mesh.read()?.meshId ?? "");
  });

  test("a denied join writes no admit, keeps nothing on the joiner and closes 4401", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const pending = new PendingJoins();
    const run = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    pending.decide((await pending.next()).nonce, false);
    expect(await failure(run.joined)).toContain("the join was denied on the inviting member");
    expect(records(a).map((record) => parseRecord(record)?.type)).toEqual(["found"]);
    expect(b.mesh.read()).toBeUndefined();
    expect(run.inviterEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(a.logs).toContain("mesh: close code=4401 source=invite: the join was denied on the inviting member");
    expect(b.logs).toContain("mesh: join failed source=join-ceremony: the join was denied on the inviting member");
  });

  test("a pending join expires with its offer", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const run = runJoin(
      inviteDeps(a, new PendingJoins(), Date.now() + 30),
      joinerContext(b, a),
      b.m.identity.noise.publicKey,
    );
    expect(await failure(run.joined)).toContain("the join was expired on the inviting member");
    expect(b.mesh.read()).toBeUndefined();
  });
});

describe("J-4: races", () => {
  test("a mesh.json that appears on the joiner during the join wins, and the join fails cleanly", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const pending = new PendingJoins();
    const run = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    const asked = await pending.next();
    b.mesh.found(b.m.identity, ownOf(b));
    const own = b.mesh.read()?.meshId;
    pending.decide(asked.nonce, true, asked.code);
    expect(await failure(run.joined)).toBe("a mesh.json appeared on this host meanwhile");
    expect(b.mesh.read()?.meshId).toBe(own ?? "");
    expect(b.logs).toContain("mesh: close code=4401 source=join-welcome: a mesh.json appeared on this host meanwhile");
  });

  test("two joins served at once by a host with no mesh found exactly one mesh", async () => {
    const [a, b, c] = [side("alpha"), side("beta"), side("gamma")];
    const pending = autoJoins();
    const first = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    const second = runJoin(inviteDeps(a, pending), joinerContext(c, a), c.m.identity.noise.publicKey);
    const ids = await Promise.all([first.joined, second.joined]);
    expect(ids[0]).toBe(ids[1] ?? "");
    expect(records(a).filter((record) => parseRecord(record)?.type === "found")).toHaveLength(1);
  });
});

describe("the inviter checks the card (section 4.4 step 3)", () => {
  test("a card whose Noise key is not the one that proved itself in the handshake is refused, and nothing is admitted", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const run = runJoin(inviteDeps(a, autoJoins()), joinerContext(b, a), generateX25519().publicKey);
    expect(await failure(run.invited)).toBe("the card's Noise key is not the session's");
    expect(records(a).map((record) => parseRecord(record)?.type)).toEqual(["found"]);
    expect(b.mesh.read()).toBeUndefined();
  });
});

describe("J-5: the joiner trusts nothing in the welcome it did not check", () => {
  test("a dialed key that is not the inviting member's key in the mesh is refused", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const ctx = joinerContext(b, a, generateX25519().publicKey);
    const run = runJoin(inviteDeps(a, autoJoins()), ctx, b.m.identity.noise.publicKey);
    expect(await failure(run.joined)).toBe("the inviting member's key in the mesh is not the key this host dialed");
    expect(b.mesh.read()).toBeUndefined();
    expect(run.joinerEnd.closeCode).toBe(CloseCode.UnknownDevice);
  });

  test.each([
    ["for another mesh", "other-mesh", "the welcome is for another mesh"],
    ["without this host's admit", "no-admit", "the welcome does not admit this host with its own card"],
    [
      "admitting this host with another Noise key",
      "stale-noise",
      "the welcome admits this host with another Noise key",
    ],
  ] as const)("a welcome %s is refused", async (_, kind, reason) => {
    expect(await fakeWelcome(kind)).toBe(reason);
  });
});

const noiseOf = (keys: { readonly publicKey: Uint8Array }): string => Buffer.from(keys.publicKey).toString("base64url");
const noise = (s: Side): string => noiseOf(s.m.identity.noise);
const hashOfSigned = (record: Signed | undefined): string =>
  record === undefined ? "" : new Bun.CryptoHasher("sha256").update(record.body).digest("base64url");

/** A dishonest inviter: answers the card with a welcome built from `a`'s real mesh but bent one way. */
async function fakeWelcome(kind: "other-mesh" | "no-admit" | "stale-noise"): Promise<string> {
  const [a, b, elsewhere] = [side("alpha"), side("beta"), side("other")];
  a.mesh.found(a.m.identity, ownOf(a));
  elsewhere.mesh.found(elsewhere.m.identity, ownOf(elsewhere));
  const meshId = a.mesh.read()?.meshId ?? "";
  if (kind === "stale-noise") {
    const body = { ...cardBody(b.m.identity, ownOf(b), meshId, signPubOf(a.m)), noisePub: noiseOf(generateX25519()) };
    const stale = signCard(body, b.m.identity.sign.secretKey);
    a.mesh.sign(a.m.identity, (n, prev) => ({
      v: 2,
      mesh: meshId,
      type: "admit",
      by: signPubOf(a.m),
      n,
      prev,
      subject: { card: stale },
    }));
  }
  const welcome = kind === "other-mesh" ? (elsewhere.mesh.read()?.records ?? []) : records(a);
  const [inviterEnd, joinerEnd] = memoryLinkPair();
  const inviter = new MeshLines(inviterEnd, INVITER_EXPECTS);
  const joined = failure(runJoiner(new MeshLines(joinerEnd, JOINER_EXPECTS), joinerContext(b, a)));
  inviter.send({
    t: "offer",
    mesh: meshId,
    inviter: signPubOf(a.m),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
  });
  await inviter.next();
  inviter.send({ t: "records", records: welcome });
  inviter.send({ t: "done", mesh: meshId });
  const outcome = await joined;
  expect(b.mesh.read()).toBeUndefined();
  return outcome;
}
