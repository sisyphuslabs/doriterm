import { StoredSet } from "./honest-records.ts";
import { plantRecords } from "./plant.ts";
import { type Head, lastOwn, type SignedGraph, signAttack } from "./records.ts";
import type { ShapeRun } from "./shape-setup.ts";
import { meshFileOf, type SignedRecord, storedRecords } from "./status.ts";

const FAILED_SYNC = /^\S+ mesh: sync with .* failed/;

/**
 * FORK as the model has it: the honest record the shape names (`fork`), which must be the revoked key's last own
 * record on its own host (section 3.7's L). A chain continuing from any earlier record would reuse a counter, and the
 * view voids such a record whatever the shape, so the attack would test nothing.
 */
function forkOf(run: ShapeRun, records: readonly SignedRecord[], signPub: string): Head {
  const set = new StoredSet(records, run.lib.hashOf);
  const step = run.shape.honest.find((each) => each.id === run.shape.fork);
  const hash = step === undefined ? undefined : set.find(step, (key) => run.actors.get(key)?.signPub ?? "");
  if (hash === undefined) throw new Error(`${run.shape.id}: the revoked host holds no ${run.shape.fork}`);
  if (lastOwn(run.lib, records, signPub).hash !== hash) {
    throw new Error(`${run.shape.id}: the revoked key wrote after ${run.shape.fork}, which the model does not have`);
  }
  return { hash, n: set.counterAt(hash, signPub) };
}

/** The shape's attack, signed with the revoked key and the keys it mints, continuing from the revoked key's fork. */
export function attackGraph(run: ShapeRun): SignedGraph {
  const revoked = run.mesh.host(run.host(run.shape.revoked));
  const signPub = run.actors.get(run.shape.revoked)?.signPub;
  if (signPub === undefined) throw new Error(`${run.shape.id}: no keys for ${run.shape.revoked}`);
  const fork = forkOf(run, storedRecords(revoked), signPub);
  return signAttack(run.lib, meshFileOf(revoked).meshId, run.shape, run.actors, fork);
}

/**
 * The revoked channel at N = 2: the revoked host was offline when the revoke was written, and comes back holding the
 * backdated records as a thief would have signed them there. The revoker's only push to it is section 5.3's, held
 * until an ack comes back or 10 s pass, and at N = 2 no ack can come. So the host comes back right after the revoke is
 * written, and if a judge's push already ran (a failed sync on its log), the setup fails here instead of the scenario
 * waiting for a delivery that can no longer happen.
 */
export async function returnRevoked(run: ShapeRun): Promise<SignedGraph> {
  const revoked = run.mesh.host(run.host(run.shape.revoked));
  const signPub = run.actors.get(run.shape.revoked)?.signPub ?? "";
  const judges = run.shape.judges.map((key) => run.mesh.host(run.host(key)));
  const from = judges.map((judge) => judge.logs.length);
  const graph = attackGraph(run);
  plantRecords(revoked, signPub, graph.records);
  await revoked.start();
  const early = judges.flatMap((judge, index) =>
    judge.logs.slice(from[index]).filter((line) => FAILED_SYNC.test(line)),
  );
  if (early.length > 0) {
    throw new Error(`${run.shape.id}: a judge pushed before ${revoked.name} was back:\n${early.join("\n")}`);
  }
  return graph;
}
