import { describe, expect, test } from "bun:test";
import { viewOf } from "@doriface/mesh";
import { LARGE_MESH_MS } from "../testing/mesh-commands-bench.ts";
import { machine, signPubOf } from "../testing/mesh-history.ts";
import { plan, ref, withMesh } from "../testing/mesh-plan.ts";

describe("design 6.1: what mesh revoke writes and what it says first", () => {
  test("a plain revoke names one key and warns about the subtree it leaves in place", () => {
    const f = machine("f"),
      a = machine("a"),
      b = machine("b"),
      d = machine("d"),
      e = machine("e");
    withMesh(f, (mesh) => {
      mesh.admit(f, a);
      mesh.admit(f, b);
      mesh.admit(a, d);
      mesh.admit(a, e);
      const p = plan(mesh, f, "a");
      expect(p.keys).toEqual([signPubOf(a)]);
      expect(p.reason).toBe("revoke");
      expect(p.subtree).toEqual([ref(d), ref(e)]);
      expect(p.undecidable).toEqual([]);
      expect(p.needsYes).toBe(false);
    });
  });

  test("--compromised names the member and its whole subtree in one record, and always asks", () => {
    const f = machine("f"),
      a = machine("a"),
      b = machine("b"),
      d = machine("d"),
      e = machine("e");
    withMesh(f, (mesh) => {
      mesh.admit(f, a);
      mesh.admit(f, b);
      mesh.admit(a, d);
      mesh.admit(d, e);
      const p = plan(mesh, f, a.identity.hostId, true);
      expect(p.keys).toEqual([a, d, e].map(signPubOf));
      expect(p.reason).toBe("compromised");
      expect(p.target).toEqual(ref(a));
      expect(p.needsYes).toBe(true);
    });
  });

  test("an empty pool names the members whose position has one, and needs --yes", () => {
    const f = machine("f"),
      a = machine("a"),
      x = machine("x");
    withMesh(f, (mesh) => {
      mesh.admit(f, a);
      mesh.admit(a, x);
      const p = plan(mesh, f, "a");
      expect(p.undecidable).toEqual([{ subject: ref(a), present: [ref(f)], askFrom: [ref(x)] }]);
      expect(p.needsYes).toBe(true);
    });
  });

  test("with no member to ask (N = 2) it says the mesh cannot decide, and still allows --yes", () => {
    const f = machine("f"),
      a = machine("a");
    withMesh(f, (mesh) => {
      mesh.admit(f, a);
      const p = plan(mesh, f, "a");
      expect(p.undecidable).toEqual([{ subject: ref(a), present: [ref(f)], askFrom: [] }]);
      expect(p.needsYes).toBe(true);
    });
  });

  test(
    "--compromised names the thirteenth member, which the member admitted (f admits 11, a admits z)",
    () => {
      const f = machine("f"),
        a = machine("a"),
        z = machine("z");
      withMesh(f, (mesh) => {
        mesh.admit(f, a);
        for (let i = 1; i <= 10; i++) mesh.admit(f, machine(`m${i}`));
        mesh.admit(a, z);
        const records = mesh.store.read()?.records ?? [];
        expect(viewOf(records).members.has(signPubOf(z))).toBe(true);
        const p = plan(mesh, f, "a", true);
        expect(p.keys).toEqual([a, z].map(signPubOf));
        expect(p.subtree).toEqual([ref(z)]);
      });
    },
    LARGE_MESH_MS,
  );

  test("an exact hostId wins over a member renamed to that hostId", () => {
    const f = machine("f"),
      a = machine("a"),
      b = machine("b");
    withMesh(f, (mesh) => {
      mesh.admit(f, a);
      mesh.admit(f, b);
      mesh.record(f, "name", { signPub: signPubOf(a), name: b.identity.hostId });
      expect(plan(mesh, f, b.identity.hostId).target.hostId).toBe(b.identity.hostId);
    });
  });

  test("it refuses this host and a key that is no member", () => {
    const f = machine("f"),
      a = machine("a");
    withMesh(f, (mesh) => {
      mesh.admit(f, a);
      expect(() => plan(mesh, f, "f")).toThrow("mesh leave");
      expect(() => plan(mesh, f, "nobody")).toThrow('no member "nobody"');
      mesh.revoke(f, a);
      expect(() => plan(mesh, f, a.identity.hostId)).toThrow("no member");
    });
  });
});
