import { generateHostIdentity, generateX25519 } from "@doriface/crypto";
import { parseRecord, type Signed, signCard } from "@doriface/mesh";
import { afterEach, describe, expect, test } from "bun:test";
import { parsePolicy } from "@doriface/policy";
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
import { cardFor, type Machine, machine, noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { PendingJoins } from "./pending-joins.ts";

afterEach(removeSides);

const records = (s: Side): readonly Signed[] => s.mesh.read()?.records ?? [];
const types = (s: Side): readonly (string | undefined)[] => records(s).map((record) => parseRecord(record)?.type);
const autoJoins = (): PendingJoins => {
  const pending = new PendingJoins();
  pending.setAuto(Date.now() + 60_000);
  return pending;
};

test("refreshing an admitted machine does not consume another machine slot at the limit", async () => {
  const [a, b] = [side("alpha"), side("beta")];
  const lost = runJoin(inviteDeps(a, autoJoins()), joinerContext(b, a), b.m.identity.noise.publicKey);
  lost.inviterEnd.tap = (bytes) => (isWelcome(bytes) ? [] : [bytes]);
  await lost.invited;
  lost.inviterEnd.close(1001, "the relay dropped the session");
  await failure(lost.joined);
  const before = records(a);
  const policy = parsePolicy('{"limits":{"machines":2}}');
  const retry = runJoin(
    inviteDeps(a, autoJoins(), Date.now() + 60_000, policy),
    joinerContext(b, a),
    b.m.identity.noise.publicKey,
  );
  expect(await retry.joined).toBe(a.mesh.read()?.meshId ?? "");
  expect(records(a)).toEqual(before);
});

/** A machine `inviter` admitted and then revoked, as the stored set records it. */
function admittedThenRevoked(inviter: Side): Machine {
  inviter.mesh.found(inviter.m.identity, ownOf(inviter));
  const meshId = inviter.mesh.read()?.meshId ?? "";
  const z = machine("zeta");
  const by = signPubOf(inviter.m);
  const card = cardFor(z, meshId, inviter.m);
  inviter.mesh.sign(inviter.m.identity, (n, prev) => ({
    v: 2,
    mesh: meshId,
    type: "admit",
    by,
    n,
    prev,
    subject: { card },
  }));
  inviter.mesh.sign(inviter.m.identity, (n, prev) => ({
    v: 2,
    mesh: meshId,
    type: "revoke",
    by,
    n,
    prev,
    subject: { signPubs: [signPubOf(z)], reason: "revoke" },
  }));
  return z;
}

const isWelcome = (bytes: Uint8Array): boolean => /^\{"t":"(records|done)"/.test(new TextDecoder().decode(bytes));

describe("section 4.4 step 3: a member whose welcome was lost joins again", () => {
  test("the retry is welcomed without a second admit, and both mesh.json files hold the same records", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    const lost = runJoin(inviteDeps(a, autoJoins()), joinerContext(b, a), b.m.identity.noise.publicKey);
    lost.inviterEnd.tap = (bytes) => (isWelcome(bytes) ? [] : [bytes]);
    await lost.invited;
    lost.inviterEnd.close(1001, "the relay dropped the session");
    expect(await failure(lost.joined)).not.toBe("resolved");
    expect(b.mesh.read()).toBeUndefined();
    expect(types(a)).toEqual(["found", "admit"]);

    const pending = new PendingJoins();
    const retry = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    const asked = await pending.next();
    pending.decide(asked.nonce, true, asked.code);
    expect(await retry.joined).toBe(a.mesh.read()?.meshId ?? "");
    expect(types(a)).toEqual(["found", "admit"]);
    expect(records(b)).toEqual(records(a));
    expect([retry.inviterEnd.closeCode, retry.joinerEnd.closeCode]).toEqual([undefined, undefined]);
  });

  test("a joiner admitted another way while its join waited for approval gets the welcome, not a second admit", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    a.mesh.found(a.m.identity, ownOf(a));
    const meshId = a.mesh.read()?.meshId ?? "";
    const pending = new PendingJoins();
    const run = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    const asked = await pending.next();
    const earlier = signCard(cardBody(b.m.identity, ownOf(b), meshId, signPubOf(a.m)), b.m.identity.sign.secretKey);
    a.mesh.sign(a.m.identity, (n, prev) => ({
      v: 2,
      mesh: meshId,
      type: "admit",
      by: signPubOf(a.m),
      n,
      prev,
      subject: { card: earlier },
    }));
    pending.decide(asked.nonce, true, asked.code);
    expect(await run.joined).toBe(meshId);
    expect(types(a)).toEqual(["found", "admit"]);
    expect(records(b)).toEqual(records(a));
  });

  test("a joiner admitted with another Noise key while its join waited for approval gets no welcome", async () => {
    const [a, b] = [side("alpha"), side("beta")];
    a.mesh.found(a.m.identity, ownOf(a));
    const meshId = a.mesh.read()?.meshId ?? "";
    const pending = new PendingJoins();
    const run = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
    const asked = await pending.next();
    const otherKey = Buffer.from(generateX25519().publicKey).toString("base64url");
    const body = { ...cardBody(b.m.identity, ownOf(b), meshId, signPubOf(a.m)), noisePub: otherKey };
    const card = signCard(body, b.m.identity.sign.secretKey);
    a.mesh.sign(a.m.identity, (n, prev) => ({
      v: 2,
      mesh: meshId,
      type: "admit",
      by: signPubOf(a.m),
      n,
      prev,
      subject: { card },
    }));
    pending.decide(asked.nonce, true, asked.code);
    expect(await failure(run.invited)).toContain("this host is a member with another Noise key");
    expect(b.mesh.read()).toBeUndefined();
  });

  test("a twin whose Noise key a member took while its join waited is refused inside the admit transaction", async () => {
    const [a, twinSide] = [side("alpha"), side("twin")];
    a.mesh.found(a.m.identity, ownOf(a));
    const meshId = a.mesh.read()?.meshId ?? "";
    const z = machine("zeta");
    const twin = { ...generateHostIdentity(), noise: z.identity.noise };
    const pending = new PendingJoins();
    const run = runJoin(
      inviteDeps(a, pending),
      { ...joinerContext(twinSide, a), identity: twin },
      twin.noise.publicKey,
    );
    const asked = await pending.next();
    const card = cardFor(z, meshId, a.m);
    a.mesh.sign(a.m.identity, (n, prev) => ({
      v: 2,
      mesh: meshId,
      type: "admit",
      by: signPubOf(a.m),
      n,
      prev,
      subject: { card },
    }));
    pending.decide(asked.nonce, true, asked.code);
    expect(await failure(run.invited)).toBe("this Noise key is another mesh member's");
    expect(types(a)).toEqual(["found", "admit"]);
    expect(twinSide.mesh.read()).toBeUndefined();
  });

  test("#90: a new signing key presenting a revoked member's Noise key is refused, and no admit is written", async () => {
    const [a, twinSide] = [side("alpha"), side("twin")];
    const z = admittedThenRevoked(a);
    const twin = { ...generateHostIdentity(), noise: z.identity.noise };
    const run = runJoin(
      inviteDeps(a, autoJoins()),
      { ...joinerContext(twinSide, a), identity: twin },
      twin.noise.publicKey,
    );
    expect(await failure(run.invited)).toBe("this Noise key is another mesh member's");
    expect(types(a)).toEqual(["found", "admit", "revoke"]);
    expect(twinSide.mesh.read()).toBeUndefined();
  });

  test("#90: a revoked member joining again under its own keys is re-admitted and authorized", async () => {
    const [a, zSide] = [side("alpha"), side("zeta")];
    const z = admittedThenRevoked(a);
    const run = runJoin(
      inviteDeps(a, autoJoins()),
      { ...joinerContext(zSide, a), identity: z.identity },
      z.identity.noise.publicKey,
    );
    expect(await run.joined).toBe(a.mesh.read()?.meshId ?? "");
    expect(types(a)).toEqual(["found", "admit", "revoke", "admit"]);
    expect(a.mesh.authorizeIndex()?.member(noiseOf(z))?.signPub).toBe(signPubOf(z));
  });
});
