import { generateHostIdentity } from "@doriface/crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inOrder } from "../sequential.ts";
import type { BackdateShape, Step } from "./backdate-graphs.ts";
import { StoredSet } from "./honest-records.ts";
import { identityOf } from "./identity.ts";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";
import type { MeshLib } from "./mesh-lib.ts";
import { type Actor, actorOf, type SignedGraph } from "./records.ts";
import { statusOf, storedRecords, viewOf } from "./status.ts";

/** A shape on real hosts: who is who, and what the honest revoke's warning did. */
export interface ShapeRun {
  readonly mesh: Mesh;
  readonly lib: MeshLib;
  readonly shape: BackdateShape;
  /** Every key of the shape, minted ones included. */
  readonly actors: ReadonlyMap<string, Actor>;
  readonly host: (key: string) => string;
  /** For the honest revoke: whether its witness pool (status `witnessPool`) was empty, and whether `--yes` was needed. */
  readonly warning: { readonly poolEmpty: boolean; readonly neededYes: boolean } | undefined;
  /** The attack the setup planted on the revoked host when it brought it back (the revoked channel). */
  readonly planted: SignedGraph | undefined;
}

const hostKeys = (shape: BackdateShape): readonly string[] => Object.keys(shape.hosts);

export async function actorsOf(mesh: Mesh, shape: BackdateShape): Promise<Map<string, Actor>> {
  const hosted = await Promise.all(
    hostKeys(shape).map(async (key): Promise<[string, Actor]> => {
      const host = mesh.host(shape.hosts[key] ?? "");
      return [key, actorOf(identityOf(host), host.name, (await mesh.core(host.name)).hello.core.id)];
    }),
  );
  const minted = shape.minted.map((key): [string, Actor] => {
    const name = key.toLowerCase();
    return [key, actorOf(generateHostIdentity(), name, `hc-${name}`)];
  });
  return new Map([...hosted, ...minted]);
}

/** A host that has written no `mesh.json` yet holds no record. */
const heldBy = (host: MeshHost) => (existsSync(join(host.stateDir, "mesh.json")) ? storedRecords(host) : []);

/** Waits until every running honest host holds the step's record and, for an ack step, the ack itself (5.5). */
async function untilWritten(run: ShapeRun, step: Step, online: readonly string[]): Promise<void> {
  const keyOf = (key: string): string => run.actors.get(key)?.signPub ?? "";
  const lib = run.lib;
  await run.mesh.until(`${run.shape.id}: ${step.id} on ${online.join(", ")}`, () =>
    online.every((name) => {
      const set = new StoredSet(heldBy(run.mesh.host(name)), lib.hashOf);
      if (step.type !== "ack") return set.find(step, keyOf) !== undefined;
      const after = step.prev.map((id) => run.shape.honest.find((each) => each.id === id));
      return after.every((prior) => {
        const hash = prior === undefined ? undefined : set.find(prior, keyOf);
        return hash !== undefined && set.ackedAfter(keyOf(step.by), hash);
      });
    }),
  );
}

/**
 * `mesh revoke <hostId>`: without `--yes` first, which section 6.1 refuses exactly when the witness pool is empty. The
 * member is named by hostId: a founder's mesh name is its core's name, not the harness's host name.
 */
async function revokeWithWarning(run: ShapeRun, step: Step): Promise<ShapeRun["warning"]> {
  const revoker = run.mesh.host(run.host(step.by));
  const subject = run.mesh.host(run.host(step.subjects?.[0] ?? ""));
  const member = (await statusOf(revoker)).members.find((entry) => entry.hostId === subject.hostId);
  const poolEmpty = member?.pool?.length === 0;
  const plain = await revoker.cli("mesh", "revoke", subject.hostId);
  if (plain.exit === 0) return { poolEmpty, neededYes: false };
  const confirmed = await revoker.cli("mesh", "revoke", subject.hostId, "--yes");
  if (confirmed.exit !== 0)
    throw new Error(`mesh revoke ${subject.name} failed: ${confirmed.stderr}${confirmed.stdout}`);
  return { poolEmpty, neededYes: true };
}

/**
 * Writes the shape's honest part with the operators' real commands, in order, waiting for each to spread. Once the
 * revoke is written everywhere, `afterRevoke` runs (the revoked channel brings the revoked host back there).
 */
export async function setUpShape(
  mesh: Mesh,
  lib: MeshLib,
  shape: BackdateShape,
  afterRevoke?: (run: ShapeRun) => Promise<SignedGraph>,
): Promise<ShapeRun> {
  const host = (key: string): string => {
    const name = shape.hosts[key];
    if (name === undefined) throw new Error(`${shape.id}: ${key} has no host`);
    return name;
  };
  const actors = await actorsOf(mesh, shape);
  let warning: ShapeRun["warning"];
  let planted: SignedGraph | undefined;
  const run = (): ShapeRun => ({ mesh, lib, shape, actors, host, warning, planted });
  const online = new Set<string>();
  let revoked = false;
  const write = async (step: Step): Promise<void> => {
    if (step.id === shape.offlineBefore) {
      await mesh.host(host(shape.revoked)).stop();
      online.delete(shape.revoked);
    }
    // No command founds the mesh: the first admit's `mesh pair --auto` does, and an admit is only stored in a founded mesh.
    if (step.type === "found") {
      online.add(step.by);
      return;
    }
    if (step.type === "admit" && step.subject !== undefined) {
      await mesh.join(host(step.by), host(step.subject));
      online.add(step.subject);
    }
    if (step.type === "revoke") {
      warning = await revokeWithWarning(run(), step);
      revoked = true;
    }
    if (step.type === "name" && step.subject !== undefined && step.name !== undefined) {
      const renamed = await mesh.host(host(step.by)).cli("mesh", "rename", host(step.subject), step.name);
      if (renamed.exit !== 0) throw new Error(`mesh rename failed: ${renamed.stderr}${renamed.stdout}`);
    }
    const holders = [...online].filter((key) => !revoked || key !== shape.revoked);
    await untilWritten(run(), step, holders.map(host));
    if (step.type === "revoke" && afterRevoke !== undefined) planted = await afterRevoke(run());
  };
  await inOrder(shape.honest, write);
  await untilViews(
    run(),
    [...online].filter((key) => key !== shape.revoked),
  );
  return run();
}

/** Every honest running host's view is the honest one before the attack: all keys but the revoked one. */
async function untilViews(run: ShapeRun, honest: readonly string[]): Promise<void> {
  const want = honest.map((key) => run.mesh.host(run.host(key)).hostId).toSorted();
  await run.mesh.until(`${run.shape.id}: the honest view before the attack`, async () => {
    const views = await Promise.all(
      honest.map(async (key) => (await viewOf(run.mesh.host(run.host(key)))).map((m) => m.hostId)),
    );
    return views.every((view) => JSON.stringify(view.toSorted()) === JSON.stringify(want));
  });
}
