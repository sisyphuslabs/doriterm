import { type ForbiddenWatch, watchForbidden } from "./forbidden-watch.ts";
import { deliver, type Delivery, type Judgement, untilJudged } from "./inject.ts";
import { StoredSet } from "./honest-records.ts";
import { identityOf } from "./identity.ts";
import { isolate } from "./isolate.ts";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";
import { plantRecords } from "./plant.ts";
import { type Head, lastOwn, signAttack } from "./records.ts";
import type { ShapeRun } from "./shape-setup.ts";
import { meshFileOf, type SignedRecord, type Status, statusOf, storedRecords } from "./status.ts";

export interface AttackResult {
  /** How each judge's own session served the injection (member channel only). */
  readonly deliveries: readonly Delivery["kind"][];
  /** Each judge's judgement of every attack record, by judge host name. */
  readonly judgements: ReadonlyMap<string, readonly Judgement[]>;
  /** Every sighting of a minted key on a judge, from the first injected byte to the settled view. */
  readonly sightings: readonly string[];
  /** Each judge's status once its view is the expected one. */
  readonly statuses: ReadonlyMap<string, Status>;
}

const MEMBERS_MS = 120_000;

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

/** Injects through member sessions, each judge's carrier being the next judge, with every pair isolated (5.1). */
async function injectThroughMembers(
  mesh: Mesh,
  judges: readonly MeshHost[],
  meshId: string,
  records: readonly SignedRecord[],
): Promise<Delivery[]> {
  const pairs = judges.map((target, index) => ({ carrier: judges[(index + 1) % judges.length] ?? target, target }));
  const heal = await isolate(mesh, pairs);
  try {
    return await Promise.all(
      pairs.map(({ carrier, target }) => deliver({ mesh, carrier: identityOf(carrier), target, meshId, records })),
    );
  } finally {
    heal();
  }
}

/**
 * Signs the shape's attack with the revoked key and the keys it mints, gets it to every judge through the shape's
 * channel, waits until each judge has judged every record (the door's refusal line or the hash in `mesh.json`), then
 * until each judge's view is the shape's. A minted key seen on a judge at any point in that window is reported.
 */
export async function runAttack(run: ShapeRun): Promise<AttackResult> {
  const { mesh, lib, shape } = run;
  const keyHost = (key: string) => mesh.host(run.host(key));
  const revoked = keyHost(shape.revoked);
  const revokedActor = run.actors.get(shape.revoked);
  if (revokedActor === undefined) throw new Error(`${shape.id}: no keys for ${shape.revoked}`);
  const meshId = meshFileOf(revoked).meshId;
  const fork = forkOf(run, storedRecords(revoked), revokedActor.signPub);
  const graph = signAttack(lib, meshId, shape, run.actors, fork);
  const hashes = shape.attack.map((step) => graph.hashes.get(step.id) ?? "");
  const judges = shape.judges.map(keyHost);
  const minted = shape.minted.flatMap((key) => {
    const actor = run.actors.get(key);
    return actor === undefined ? [] : [actor];
  });
  const watch: ForbiddenWatch = watchForbidden(
    mesh,
    judges.map((judge) => judge.name),
    { hostIds: minted.map((actor) => actor.keys.hostId), coreIds: minted.map((actor) => actor.hcId) },
  );
  const sessions: Delivery[] = [];
  try {
    if (shape.channel === "member") {
      sessions.push(...(await injectThroughMembers(mesh, judges, meshId, graph.records)));
    } else {
      plantRecords(revoked, revokedActor.signPub, graph.records);
      await revoked.start();
    }
    const judged = await Promise.all(judges.map((judge) => untilJudged(mesh, judge, hashes, lib.hashOf)));
    const judgements = new Map<string, readonly Judgement[]>(
      judges.map((judge, index) => [judge.name, hashes.map((hash) => judged[index]?.get(hash) ?? "refused")]),
    );
    const want = JSON.stringify(shape.members.map((key) => keyHost(key).hostId).toSorted());
    const statuses = new Map<string, Status>();
    await mesh.until(
      `${shape.id}: every judge's view is ${JSON.stringify(shape.members)}`,
      async () => {
        const seen = await Promise.all(judges.map((judge) => statusOf(judge)));
        for (const [index, judge] of judges.entries())
          statuses.set(judge.name, seen[index] ?? { sync: "", members: [], stuck: [] });
        return seen.every((status) => JSON.stringify(status.members.map((member) => member.hostId)) === want);
      },
      MEMBERS_MS,
    );
    return { deliveries: sessions.map((session) => session.kind), judgements, sightings: await watch.stop(), statuses };
  } finally {
    for (const session of sessions) session.close();
  }
}
