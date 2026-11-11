import { afterEach, expect, test } from "bun:test";
import { beginClient, clearPropagation, roster, welcome } from "../testing/client-propagation-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { fixture } from "../testing/roster-resume-harness.ts";

/**
 * A host whose sync layer refuses to take a membership change still completes the committed write: the announcement
 * runs after the records are signed, so a failure there may neither refuse the client nor replace the session's error.
 */
function unreachableSync() {
  const logs: string[] = [];
  const f = fixture({
    changed: () => {
      throw new Error("the sync layer is gone");
    },
    log: (line) => void logs.push(line),
  });
  const announced = (): boolean => logs.some((line) => line.includes("cannot announce the membership change"));
  return { f, logs, announced };
}

afterEach(clearPropagation);

test("a throwing announcement does not refuse the client the join already admitted", async () => {
  const { f, announced } = unreachableSync();
  const joined = await beginClient(f);
  f.host.pending.decide(joined.pending.nonce, true, joined.pending.code);
  joined.lines.send({ t: "confirm" });
  await welcome(joined.lines);
  expect(f.a.mesh.authorizeIndex()?.client(noiseOf(f.c.m))?.signPub).toBe(signPubOf(f.c.m));
  expect(announced()).toBe(true);
});

test("a throwing announcement does not fail a roster admission", async () => {
  const { f, announced } = unreachableSync();
  f.devices.add(f.c.m.identity.noise.publicKey, "browser");
  await roster(f);
  expect(f.a.mesh.authorizeIndex()?.client(noiseOf(f.c.m))?.signPub).toBe(signPubOf(f.c.m));
  expect(announced()).toBe(true);
});

test("a throwing announcement does not fail a roster leave", async () => {
  const { f, announced } = unreachableSync();
  f.devices.add(f.c.m.identity.noise.publicKey, "browser");
  await roster(f);
  await roster(f, f.c, "leave");
  expect(f.a.mesh.authorizeIndex()?.client(noiseOf(f.c.m))).toBeUndefined();
  expect(announced()).toBe(true);
});

test("a throwing announcement does not undo the revoke a roster sweep committed", async () => {
  const { f, logs, announced } = unreachableSync();
  f.devices.add(f.c.m.identity.noise.publicKey, "browser");
  await roster(f);
  f.devices.revoke(noiseOf(f.c.m));
  logs.length = 0;
  f.host.sweepRoster();
  expect(f.a.mesh.authorizeIndex()?.client(noiseOf(f.c.m))).toBeUndefined();
  expect(announced()).toBe(true);
  expect(logs.filter((line) => line.includes("roster sweep stopped"))).toEqual([]);
});
