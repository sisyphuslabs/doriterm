import { describe, expect, test } from "bun:test";
import { viewOf } from "@doriface/mesh";
import { LARGE_MESH_MS } from "../testing/mesh-commands-bench.ts";
import { machine, signPubOf } from "../testing/mesh-history.ts";
import { plan, ref, twelve, withMesh } from "../testing/mesh-plan.ts";

describe("the subtree follows each key's one admitter, its governing admission's signer (H1b)", () => {
  test(
    "C1: a second admit of the thirteenth member does not make it the second admitter's lineage",
    () => {
      const f = machine("f"),
        a = machine("a"),
        z = machine("z");
      withMesh(f, (mesh) => {
        const [m1] = twelve(mesh, f, a);
        if (m1 === undefined) throw new Error("no m1");
        mesh.admit(m1, z);
        mesh.admit(a, z);
        expect(plan(mesh, f, "a", true).keys).toEqual([signPubOf(a)]);
      });
    },
    LARGE_MESH_MS,
  );

  test(
    "D1: a key revoked and re-admitted by another member leaves the first admitter's lineage",
    () => {
      const f = machine("f"),
        a = machine("a"),
        z = machine("z");
      withMesh(f, (mesh) => {
        const [m1] = twelve(mesh, f, a);
        if (m1 === undefined) throw new Error("no m1");
        mesh.admit(a, z);
        mesh.revoke(f, z);
        mesh.admit(m1, z);
        expect(plan(mesh, f, "a", true).keys).toEqual([signPubOf(a)]);
      });
    },
    LARGE_MESH_MS,
  );

  test(
    "G: a non-governing admit of a re-admitted thirteenth member sweeps in neither it nor the members it admitted",
    () => {
      const f = machine("f"),
        a = machine("a"),
        b = machine("b"),
        c = machine("c");
      withMesh(f, (mesh) => {
        mesh.admit(f, a);
        mesh.admit(f, b);
        mesh.admit(a, c);
        const rest = Array.from({ length: 9 }, (_, i) => machine(`m${i + 1}`));
        for (const m of rest.slice(0, 8)) mesh.admit(f, m);
        mesh.revoke(f, a);
        const [m1, , , , , , , , m9] = rest;
        if (m1 === undefined || m9 === undefined) throw new Error("no m1 or m9");
        mesh.admit(f, m9);
        mesh.admit(m1, a);
        mesh.admit(b, a);
        const records = mesh.store.read()?.records ?? [];
        expect(viewOf(records).members.has(signPubOf(a))).toBe(true);
        expect(plan(mesh, f, "b", true).keys).toEqual([signPubOf(b)]);
      });
    },
    LARGE_MESH_MS,
  );

  test(
    "the thirteenth member is found by its mesh name (L10)",
    () => {
      const f = machine("f"),
        a = machine("a"),
        z = machine("z");
      withMesh(f, (mesh) => {
        twelve(mesh, f, a);
        mesh.admit(a, z);
        expect(plan(mesh, f, "z").target).toEqual(ref(z));
      });
    },
    LARGE_MESH_MS,
  );
});

describe("a card name never stands for another key (L15, L16)", () => {
  test(
    "the preview gives the thirteenth member's hostId beside a card name that copies another member's hostId",
    () => {
      const f = machine("f"),
        a = machine("a");
      withMesh(f, (mesh) => {
        const [m1] = twelve(mesh, f, a);
        if (m1 === undefined) throw new Error("no m1");
        const z = machine(m1.identity.hostId);
        mesh.admit(a, z);
        expect(plan(mesh, f, "a", true).lines.join("\n")).toContain(`(${z.identity.hostId})`);
      });
    },
    LARGE_MESH_MS,
  );

  test(
    "a revoked key's hostId names no member, even when the thirteenth member's card name carries it",
    () => {
      const f = machine("f"),
        a = machine("a"),
        r = machine("r");
      withMesh(f, (mesh) => {
        twelve(mesh, f, a);
        mesh.admit(f, r);
        mesh.revoke(f, r);
        mesh.admit(a, machine(r.identity.hostId));
        expect(() => plan(mesh, f, r.identity.hostId)).toThrow("no member");
      });
    },
    LARGE_MESH_MS,
  );
});
