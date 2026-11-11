import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecord, viewOf } from "@doriface/mesh";
import { benchRecords, commandBench, lastRecord, removeBenches } from "../testing/mesh-commands-bench.ts";
import { machine, signPubOf } from "../testing/mesh-history.ts";
import { MeshStore } from "../state/mesh.ts";
import { FIRST_JOIN_PENDING, MeshCommands } from "./commands.ts";
import { IDLE_MESH_HOOKS, type MeshHooks } from "./host-hooks.ts";

afterEach(removeBenches);

describe("mesh-rename (design 7.4, 7.5)", () => {
  test("writes a name record that the view applies, and pushes it", async () => {
    const f = machine("f"),
      a = machine("a");
    const it = commandBench(f);
    it.mesh.admit(f, a);
    it.ready();
    expect(await it.commands.rename({ member: "a", name: "a2" })).toEqual({
      written: true,
      member: { hostId: a.identity.hostId, name: "a" },
      name: "a2",
    });
    expect(lastRecord(it)?.subject).toEqual({ signPub: signPubOf(a), name: "a2" });
    expect(viewOf(benchRecords(it)).name.get(signPubOf(a))).toBe("a2");
    expect(it.pushed).toHaveLength(1);
  });

  test("a member may take its own hostId as its name (L9)", async () => {
    const f = machine("f"),
      a = machine("a");
    const it = commandBench(f);
    it.mesh.admit(f, a);
    it.ready();
    expect(await it.commands.rename({ member: "a", name: a.identity.hostId })).toMatchObject({ written: true });
  });

  test("refuses herdr-invalid names and another member's name, and writes nothing for the same name", async () => {
    const f = machine("f"),
      a = machine("a");
    const it = commandBench(f);
    it.mesh.admit(f, a);
    const before = benchRecords(it).length;
    await Promise.all(
      ["A", "t7", "x".repeat(33), "-a"].map((bad) =>
        expect(it.commands.rename({ member: "a", name: bad })).rejects.toThrow("not a valid mesh name"),
      ),
    );
    await expect(it.commands.rename({ member: "a", name: "f" })).rejects.toThrow(`"f" is ${f.identity.hostId}`);
    await expect(it.commands.rename({ member: "a", name: f.identity.hostId })).rejects.toThrow(
      `"${f.identity.hostId}" is the hostId of`,
    );
    expect(await it.commands.rename({ member: "a", name: "a" })).toMatchObject({ written: false });
    expect(benchRecords(it)).toHaveLength(before);
  });
});

describe("mesh-leave (design 6.5)", () => {
  test("a push that fails counts as no confirmation, and leaving still completes", async () => {
    const a = machine("a"),
      f = machine("f");
    const it = commandBench(a);
    it.mesh.admit(a, f);
    it.ready();
    const logs: string[] = [];
    const hooks: MeshHooks = {
      ...IDLE_MESH_HOOKS,
      push: () => {
        throw new Error("no session");
      },
      confirmations: () => Promise.reject(new Error("no session")),
      left: () => Promise.reject(new Error("no core")),
    };
    const leaving = new MeshCommands({ ...it.commands.deps, hooks, log: (line) => void logs.push(line) });
    expect(await leaving.leave()).toMatchObject({
      signed: true,
      confirmed: [],
      revokeCommand: "doriface-host mesh revoke a",
      machinesKept: "Error: no core",
    });
    expect(existsSync(join(it.dir, "mesh.json"))).toBe(false);
    expect(logs.filter((line) => line.startsWith("mesh:"))).toHaveLength(2);
  });

  test("signs a self-revoke, pushes it before deleting mesh.json, and reports who confirmed", async () => {
    const a = machine("a"),
      f = machine("f"),
      b = machine("b");
    const it = commandBench(a, () => [signPubOf(f)]);
    it.mesh.admit(a, f);
    it.mesh.admit(a, b);
    it.ready();
    const reply = await it.commands.leave();
    const self = parseRecord(it.pushed[0]?.[0] ?? { body: "", sig: "" });
    expect(self).toMatchObject({
      type: "revoke",
      by: signPubOf(a),
      subject: { signPubs: [signPubOf(a)], reason: "leave" },
    });
    expect(it.storedAtPush).toEqual([true]);
    expect(existsSync(join(it.dir, "mesh.json"))).toBe(false);
    expect(reply).toEqual({
      signed: true,
      members: [f, b].map((m) => ({ hostId: m.identity.hostId, name: m.name })),
      confirmed: [{ hostId: f.identity.hostId, name: "f" }],
      revokeCommand: null,
      machinesKept: null,
    });
    expect(it.closes.count).toBe(1);
  });

  test("reaching nobody, it still leaves and prints the revoke to run elsewhere", async () => {
    const f = machine("f"),
      a = machine("a");
    const it = commandBench(f);
    it.mesh.admit(f, a);
    const asA = new MeshCommands({ ...it.commands.deps, identity: a.identity });
    expect(await asA.leave()).toMatchObject({
      signed: true,
      confirmed: [],
      revokeCommand: "doriface-host mesh revoke a",
    });
    expect(existsSync(join(it.dir, "mesh.json"))).toBe(false);
  });
});

describe("while this host's first join is pending (#1635)", () => {
  test("revoke, rename and leave say the mesh is founded once the join is admitted, not that there is none", async () => {
    const f = machine("f");
    const dir = mkdtempSync(join(tmpdir(), "dh-mesh-cmd-pending-"));
    try {
      const store = new MeshStore(dir, { log: () => {}, durable: false });
      const commands = new MeshCommands({
        store,
        stateDir: dir,
        identity: f.identity,
        closeRevoked: () => {},
        hooks: IDLE_MESH_HOOKS,
        log: () => {},
      });
      const { release } = store.prepareFound(f.identity, { name: "f", hcId: "core" });
      await expect(commands.rename({ member: "f", name: "g" })).rejects.toThrow(FIRST_JOIN_PENDING);
      await expect(commands.leave()).rejects.toThrow(FIRST_JOIN_PENDING);
      await expect(commands.revoke({ member: "x", compromised: false, yes: true })).rejects.toThrow(FIRST_JOIN_PENDING);
      expect(existsSync(join(dir, "mesh.json"))).toBe(false);
      release();
      expect(await commands.rename({ member: "f", name: "g" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
