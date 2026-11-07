import { viewOf } from "@doriface/mesh";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRevoke, type RevokePlan } from "../mesh/revoke-plan.ts";
import { type Machine, machine, MeshFixture, signPubOf } from "./mesh-history.ts";

/** Runs `body` on a fresh mesh founded by `founder` in a scratch state dir. */
export function withMesh<T>(founder: Machine, body: (mesh: MeshFixture) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dh-revoke-plan-"));
  try {
    return body(new MeshFixture(dir, founder));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `mesh revoke [--compromised] <member>` would write from `self` on the mesh as stored now. */
export function plan(mesh: MeshFixture, self: Machine, member: string, compromised = false): RevokePlan {
  const records = mesh.store.read()?.records ?? [];
  return planRevoke(records, viewOf(records), signPubOf(self), member, compromised);
}

export const ref = (m: Machine) => ({ hostId: m.identity.hostId, name: m.name });

/** f admits a and m1..m10: twelve members, so the next admitted key is the thirteenth (a mesh has no member cap). */
export function twelve(mesh: MeshFixture, f: Machine, a: Machine): readonly Machine[] {
  mesh.admit(f, a);
  const rest = Array.from({ length: 10 }, (_, i) => machine(`m${i + 1}`));
  for (const m of rest) mesh.admit(f, m);
  return rest;
}
