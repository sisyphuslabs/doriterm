import { expect, test } from "bun:test";
import { mergeAtDoor, door, hashOf, viewOf, signRecord } from "../src/index.ts";
import { A, B, MESH, noise } from "./fixtures/door-set.ts";
import { CLONE, clientCard, FRESH, OLD, OTHER, readmitFixture, SOLE, WITH_OTHER } from "./fixtures/restore-records.ts";
import { keyOf } from "./fixtures/signed.ts";

test("M10: two holders publishing the same replacement admit it once", () => {
  const one = readmitFixture();
  const retry = readmitFixture({ holder: A });
  const merged = mergeAtDoor(SOLE, [], [one, retry]);
  expect(merged.refused).toEqual([]);
  expect([...viewOf(merged.stored).members]).toEqual([A.pub, B.pub, FRESH.pub]);
});

test("M10: a request signed for another mesh cannot admit a new client", () => {
  expect(door(readmitFixture({ signedMesh: "x".repeat(26) }), SOLE)).toMatchObject({
    ok: false,
    reason: "bad readmission proof",
  });
});

test("M11: a descendant readmit cannot retroactively void the first", () => {
  const one = readmitFixture();
  const past = [...SOLE, one];
  const later = readmitFixture({ holder: A, fresh: CLONE, from: past });
  const merged = mergeAtDoor(SOLE, [], [later, one]);
  expect([...viewOf(merged.stored).members]).toEqual([A.pub, B.pub, FRESH.pub]);
  expect(viewOf(merged.stored).eff.has(hashOf(later))).toBe(false);
});

test("H7: distinct concurrent replacements remove the old client and admit neither successor", () => {
  const one = readmitFixture();
  const two = readmitFixture({ holder: A, fresh: CLONE });
  for (const records of [
    [one, two],
    [two, one],
  ]) {
    const merged = mergeAtDoor(SOLE, [], records);
    expect(merged.added).toHaveLength(2);
    const view = viewOf(merged.stored);
    expect([...view.members]).toEqual([A.pub, B.pub]);
    expect([...view.revoked]).toEqual([OLD.pub]);
    expect(view.eff.has(hashOf(one))).toBe(false);
    expect(view.eff.has(hashOf(two))).toBe(false);
  }
});

for (const reason of ["revoke", "compromised"] as const) {
  test(`H7: a concurrent ${reason} beats a readmit`, () => {
    const oldAdmission = SOLE.at(-1);
    if (oldAdmission === undefined) throw new Error("fixture lost old admission");
    const readmit = readmitFixture();
    const revoke = signRecord(
      {
        v: 2,
        mesh: MESH,
        by: A.pub,
        n: 4,
        type: "revoke",
        prev: [hashOf(oldAdmission)],
        subject: { signPubs: [OLD.pub], reason },
      },
      A.secret,
    );
    for (const records of [
      [readmit, revoke],
      [revoke, readmit],
    ]) {
      const merged = mergeAtDoor(SOLE, [], records);
      expect(merged.added).toHaveLength(2);
      expect([...viewOf(merged.stored).members]).toEqual([A.pub, B.pub]);
      expect(viewOf(merged.stored).eff.has(hashOf(revoke))).toBe(true);
    }
  });
}

test("R2: another client in the past requires its approval, even without presence evidence", () => {
  const noApproval = readmitFixture({ from: WITH_OTHER });
  const oldOnly = readmitFixture({ from: WITH_OTHER, approval: OLD });
  const approved = readmitFixture({ from: WITH_OTHER, approval: OTHER });
  for (const refused of [noApproval, oldOnly]) {
    const merged = mergeAtDoor(WITH_OTHER, [], [refused]);
    expect(viewOf(merged.stored).members.has(FRESH.pub)).toBe(false);
    expect(viewOf(merged.stored).members.has(OLD.pub)).toBe(true);
  }
  const merged = mergeAtDoor(WITH_OTHER, [], [approved]);
  expect([...viewOf(merged.stored).members]).toEqual([A.pub, B.pub, OTHER.pub, FRESH.pub]);
});

test("M14: attended replacement needs another current client, not the host or old client", () => {
  for (const approval of [A, OLD, keyOf("non-member")]) {
    const record = readmitFixture({ attended: true, from: WITH_OTHER, approval });
    expect(viewOf(mergeAtDoor(WITH_OTHER, [], [record]).stored).members.has(OLD.pub)).toBe(true);
  }
  const record = readmitFixture({ attended: true, from: WITH_OTHER, approval: OTHER });
  expect(viewOf(mergeAtDoor(WITH_OTHER, [], [record]).stored).members.has(FRESH.pub)).toBe(true);
});

test("C1: an approval cannot be used for a request with another new Noise key", () => {
  const record = readmitFixture({ from: WITH_OTHER, approval: OTHER, subject: { noise: noise(9) } });
  expect(door(record, WITH_OTHER)).toMatchObject({ ok: false, reason: "bad readmission proof" });
  expect(door(readmitFixture({ from: WITH_OTHER, approval: OTHER }), WITH_OTHER)).toEqual({ ok: true });
});

test("C3: a valid client card does not confer record-author authority in that mesh", () => {
  const parent = SOLE.at(-1);
  if (parent === undefined) throw new Error("fixture lost old admission");
  const base = { v: 2, mesh: MESH, by: OLD.pub, n: 1, prev: [hashOf(parent)] } as const;
  const attempts = [
    signRecord({ ...base, type: "ack" }, OLD.secret),
    signRecord({ ...base, type: "name", subject: { signPub: OLD.pub, name: "renamed" } }, OLD.secret),
    signRecord({ ...base, type: "revoke", subject: { signPubs: [B.pub], reason: "compromised" } }, OLD.secret),
    signRecord({ ...base, type: "admit", subject: { card: clientCard(FRESH, OLD.pub, 5) } }, OLD.secret),
    signRecord({ ...base, type: "rekey", subject: { card: clientCard(OLD, OLD.pub, 5) } }, OLD.secret),
    readmitFixture({ holder: OLD }),
  ];
  for (const record of attempts)
    expect(door(record, SOLE)).toMatchObject({ ok: false, reason: "client record author" });
  expect(door(signRecord({ ...base, by: B.pub, type: "ack" }, B.secret), SOLE)).toEqual({ ok: true });
});
