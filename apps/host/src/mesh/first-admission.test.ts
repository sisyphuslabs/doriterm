import { parseRecord, viewOf } from "@doriface/mesh";
import { JoinRefused } from "@doriface/mesh/join";
import { parsePolicy } from "@doriface/policy";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MeshStore } from "../state/mesh.ts";
import { failure, inviteDeps, joinerContext, ownOf, removeSides, runJoin, side } from "../testing/join-harness.ts";
import { PendingJoins } from "./pending-joins.ts";

afterEach(removeSides);

function autoJoins(): PendingJoins {
  const pending = new PendingJoins();
  pending.setAuto(Date.now() + 60_000);
  return pending;
}

test("a failed first admission commit leaves no counter file or welcome", async () => {
  const a = side("alpha");
  const b = side("beta");
  const observed: unknown[] = [];
  const store = new MeshStore(a.dir, {
    log: () => {},
    evaluate: (records) => {
      if (records.some((record) => parseRecord(record)?.type === "admit")) {
        observed.push(store.read());
        throw new Error("injected admission commit failure");
      }
      return viewOf(records);
    },
  });
  const run = runJoin(
    { ...inviteDeps(a, autoJoins()), mesh: store },
    joinerContext(b, a),
    b.m.identity.noise.publicKey,
  );
  expect(await failure(run.invited)).toBe("injected admission commit failure");
  expect(observed).toEqual([undefined]);
  expect(store.read()).toBeUndefined();
  expect(b.mesh.read()).toBeUndefined();
});

test("the first join counts its founder against the machine limit without founding on refusal", async () => {
  const [a, b] = [side("alpha"), side("beta")];
  const run = runJoin(
    inviteDeps(a, autoJoins(), Date.now() + 60_000, parsePolicy('{"plan":"free","limits":{"machines":1}}')),
    joinerContext(b, a),
    b.m.identity.noise.publicKey,
  );
  expect(await failure(run.invited)).toContain("This mesh has 1 machine, and the free plan allows 1");
  expect(a.mesh.read()).toBeUndefined();
});

test("denying one first join retains the candidate for pending and newly arriving joins", async () => {
  const [a, b, c, d] = [side("alpha"), side("beta"), side("gamma"), side("delta")];
  const firstPending = new PendingJoins();
  const nextPending = new PendingJoins();
  const first = runJoin(inviteDeps(a, firstPending), joinerContext(b, a), b.m.identity.noise.publicKey);
  const firstAsked = await firstPending.next();
  const next = runJoin(inviteDeps(a, nextPending), joinerContext(c, a), c.m.identity.noise.publicKey);
  const nextAsked = await nextPending.next();
  firstPending.decide(firstAsked.nonce, false);
  expect(await failure(first.invited)).toContain("denied");
  const last = runJoin(inviteDeps(a, autoJoins()), joinerContext(d, a), d.m.identity.noise.publicKey);
  const accepted = await last.joined;
  nextPending.decide(nextAsked.nonce, true, nextAsked.code);
  expect(await next.joined).toBe(accepted);
  await Promise.all([next.invited, last.invited]);
  expect(a.mesh.read()?.records.map((record) => parseRecord(record)?.type)).toEqual(["found", "admit", "admit"]);
});

test("a competing mesh on the inviter wins unchanged over a pending first admission", async () => {
  const [a, b] = [side("alpha"), side("beta")];
  const pending = new PendingJoins();
  const run = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
  const asked = await pending.next();
  a.mesh.found(a.m.identity, { ...ownOf(a), name: "other" });
  const before = readFileSync(join(a.dir, "mesh.json"), "utf8");
  pending.decide(asked.nonce, true, asked.code);
  const result = await run.invited.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(JoinRefused);
  expect(readFileSync(join(a.dir, "mesh.json"), "utf8")).toBe(before);
});

test("a first-join self refresh cannot welcome an uncommitted founding record", async () => {
  const a = side("alpha");
  const run = runJoin(inviteDeps(a, autoJoins()), joinerContext(a, a), a.m.identity.noise.publicKey);
  const result = await run.invited.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(JoinRefused);
  expect(a.mesh.read()).toBeUndefined();
});

test("removing a committed mesh prevents a pending join from recreating it", async () => {
  const [a, b, c, d] = [side("alpha"), side("beta"), side("gamma"), side("delta")];
  const pending = new PendingJoins();
  const first = runJoin(inviteDeps(a, pending), joinerContext(b, a), b.m.identity.noise.publicKey);
  const asked = await pending.next();
  const accepted = runJoin(inviteDeps(a, autoJoins()), joinerContext(c, a), c.m.identity.noise.publicKey);
  const oldMesh = await accepted.joined;
  await accepted.invited;
  rmSync(join(a.dir, "mesh.json"));
  pending.decide(asked.nonce, true, asked.code);
  expect(await first.invited.catch((error: unknown) => error)).toBeInstanceOf(JoinRefused);
  expect(a.mesh.read()).toBeUndefined();
  const fresh = runJoin(inviteDeps(a, autoJoins()), joinerContext(d, a), d.m.identity.noise.publicKey);
  const newMesh = await fresh.joined;
  await fresh.invited;
  expect(newMesh).not.toBe(oldMesh);
  expect(a.mesh.read()?.meshId).toBe(newMesh);
});
