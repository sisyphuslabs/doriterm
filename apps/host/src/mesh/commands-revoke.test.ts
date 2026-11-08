import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewOf } from "@doriface/mesh";
import { MeshStore } from "../state/mesh.ts";
import {
  benchRecords,
  commandBench,
  LARGE_MESH_MS,
  lastRecord,
  removeBenches,
} from "../testing/mesh-commands-bench.ts";
import { machine, signPubOf } from "../testing/mesh-history.ts";
import { MeshCommands } from "./commands.ts";

afterEach(removeBenches);

describe("mesh-revoke on the running host (design 6.1, 6.2)", () => {
  test("writes one revoke, closes the revoked sessions and pushes the record", async () => {
    const f = machine("f"),
      a = machine("a"),
      b = machine("b");
    const it = commandBench(f);
    it.mesh.admit(f, a);
    it.mesh.admit(f, b);
    it.mesh.record(a, "ack");
    it.ready();
    const reply = await it.commands.revoke({ member: "a", compromised: false, yes: false });
    expect(reply).toMatchObject({ written: true, reason: "revoke", subjects: [{ name: "a" }] });
    expect(lastRecord(it)?.subject).toEqual({ signPubs: [signPubOf(a)], reason: "revoke" });
    expect(viewOf(benchRecords(it)).members.has(signPubOf(a))).toBe(false);
    expect(it.closes.count).toBe(1);
    expect(it.pushed).toEqual([benchRecords(it).slice(-1)]);
  });

  test("--compromised without --yes writes nothing and returns the preview; with --yes one record names all", async () => {
    const f = machine("f"),
      a = machine("a"),
      b = machine("b"),
      d = machine("d");
    const it = commandBench(f);
    it.mesh.admit(f, a);
    it.mesh.admit(f, b);
    it.mesh.admit(a, d);
    it.ready();
    const before = benchRecords(it).length;
    const preview = await it.commands.revoke({ member: "a", compromised: true, yes: false });
    expect(preview).toMatchObject({ written: false, needsYes: true, subjects: [{ name: "a" }, { name: "d" }] });
    expect(benchRecords(it)).toHaveLength(before);
    expect(it.pushed).toEqual([]);
    await it.commands.revoke({ member: "a", compromised: true, yes: true });
    expect(benchRecords(it)).toHaveLength(before + 1);
    expect(lastRecord(it)?.subject).toEqual({ signPubs: [signPubOf(a), signPubOf(d)], reason: "compromised" });
  });

  test(
    "--compromised on a member that admitted the thirteenth member revokes that key too",
    async () => {
      const f = machine("f"),
        a = machine("a"),
        z = machine("z");
      const it = commandBench(f);
      it.mesh.admit(f, a);
      for (let i = 1; i <= 10; i++) it.mesh.admit(f, machine(`m${i}`));
      it.mesh.admit(a, z);
      it.ready();
      const reply = await it.commands.revoke({ member: "a", compromised: true, yes: true });
      expect(reply?.subjects.map((subject) => subject.hostId)).toEqual([a.identity.hostId, z.identity.hostId]);
      const view = viewOf(benchRecords(it));
      expect(view.members.has(signPubOf(z))).toBe(false);
      expect(view.revoked.has(signPubOf(z))).toBe(true);
    },
    LARGE_MESH_MS,
  );

  test("a preview writes nothing, even with yes, and a write whose previewed subjects changed is refused", async () => {
    const f = machine("f"),
      a = machine("a"),
      d = machine("d");
    const it = commandBench(f);
    it.mesh.admit(f, a);
    it.mesh.admit(a, d);
    it.ready();
    const before = benchRecords(it).length;
    const preview = await it.commands.revoke({ member: "a", compromised: true, yes: true, preview: true });
    expect(preview).toMatchObject({ written: false, subjects: [{ name: "a" }, { name: "d" }] });
    expect(benchRecords(it)).toHaveLength(before);
    const stale = { member: "a", compromised: true, yes: true, expect: [a.identity.hostId] };
    await expect(it.commands.revoke(stale)).rejects.toThrow("changed since the preview");
    expect(benchRecords(it)).toHaveLength(before);
    const expected = [a, d].map((m) => m.identity.hostId);
    expect(await it.commands.revoke({ ...stale, expect: expected })).toMatchObject({ written: true });
  });

  test("an undecidable revoke waits for --yes", async () => {
    const f = machine("f"),
      a = machine("a");
    const it = commandBench(f);
    it.mesh.admit(f, a);
    it.ready();
    expect(await it.commands.revoke({ member: "a", compromised: false, yes: false })).toMatchObject({
      written: false,
      needsYes: true,
    });
    expect(await it.commands.revoke({ member: "a", compromised: false, yes: true })).toMatchObject({ written: true });
  });

  test("a host in no mesh answers null, and a revoked host signs nothing", async () => {
    const f = machine("f"),
      a = machine("a");
    const dir = mkdtempSync(join(tmpdir(), "dh-mesh-cmd-"));
    const it = commandBench(f);
    try {
      const store = new MeshStore(dir, { log: () => {} });
      const none = new MeshCommands({ ...it.commands.deps, stateDir: dir, store });
      expect(await none.revoke({ member: "a", compromised: false, yes: true })).toBeNull();
      expect(await none.rename({ member: "a", name: "b" })).toBeNull();
      expect(await none.leave()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    it.mesh.admit(f, a);
    const asA = new MeshCommands({ ...it.commands.deps, identity: a.identity });
    it.mesh.revoke(f, a);
    await expect(asA.rename({ member: "f", name: "g" })).rejects.toThrow("signs nothing");
  });
});
