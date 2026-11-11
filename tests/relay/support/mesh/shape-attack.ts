import { SessionKind } from "@doriface/crypto";
import { handshakeRefusalLine } from "../../../../apps/host/src/e2ee/authorize.ts";
import { type ForbiddenWatch, watchForbidden } from "./forbidden-watch.ts";
import { deliver, type Delivery, type Judgement, judgementOf, untilJudged } from "./inject.ts";
import { identityOf } from "./identity.ts";
import { isolate } from "./isolate.ts";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";
import { attackGraph } from "./revoked-return.ts";
import type { ShapeRun } from "./shape-setup.ts";
import { meshFileOf, type SignedRecord, type Status, statusOf } from "./status.ts";

export interface AttackResult {
  /** How each judge's own session served the injection (member channel only). */
  readonly deliveries: readonly Delivery["kind"][];
  /** Each judge's judgement of every attack record, by judge host name; `absent` when it never received one. */
  readonly judgements: ReadonlyMap<string, readonly (Judgement | "absent")[]>;
  /** Every sighting of a minted key on a judge, from the first injected byte to the settled view. */
  readonly sightings: readonly string[];
  /** Each judge's status once its view is the expected one. */
  readonly statuses: ReadonlyMap<string, Status>;
}

const MEMBERS_MS = 120_000;
/** A member that answered 4404 is probed at most every 5 minutes (section 5.4); one probe reaches the returned host. */
const PROBE_MS = 6 * 60_000;
/** What the returned host logs when a judge's sync session (the mesh stream) reaches it: the host's own line. */
const REFUSED_AS_REVOKED = handshakeRefusalLine({ kind: SessionKind.Session, stream: "mesh" }, "revoked mesh member");

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
 * The sync point of an unreachable shape: the returned revoked host has refused a judge's session as a revoked
 * member's (section 9.2). The judges' only channel to it is then shown closed, and what they hold is final.
 */
async function untilRefusedBy(mesh: Mesh, host: MeshHost, from: number): Promise<void> {
  await mesh.until(
    `${host.name} refuses a judge's session as a revoked member's`,
    () => host.logs.slice(from).some((line) => line.includes(REFUSED_AS_REVOKED)),
    PROBE_MS,
  );
}

/**
 * Signs the shape's attack with the revoked key and the keys it mints (on the revoked channel the setup already
 * planted it on the returned host), gets it to every judge through the shape's channel, waits until each judge has judged every record (the door's refusal line or the hash in `mesh.json`), then
 * until each judge's view is the shape's. A minted key seen on a judge at any point in that window is reported.
 */
export async function runAttack(run: ShapeRun): Promise<AttackResult> {
  const { mesh, lib, shape } = run;
  const keyHost = (key: string) => mesh.host(run.host(key));
  const revoked = keyHost(shape.revoked);
  const meshId = meshFileOf(revoked).meshId;
  const graph = run.planted ?? attackGraph(run);
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
    } else if (shape.unreachable === true) {
      await untilRefusedBy(
        mesh,
        revoked,
        revoked.logs.findLastIndex((line) => line.includes("relay: connected")),
      );
    }
    const judged = await Promise.all(
      judges.map((judge) =>
        shape.unreachable === true ? new Map<string, Judgement>() : untilJudged(mesh, judge, hashes, lib.hashOf),
      ),
    );
    const judgements = new Map<string, readonly (Judgement | "absent")[]>(
      judges.map((judge, index) => [
        judge.name,
        hashes.map((hash) => judged[index]?.get(hash) ?? judgementOf(judge, hash, lib.hashOf) ?? "absent"),
      ]),
    );
    const honest = Object.keys(shape.hosts).filter((key) => key !== shape.revoked);
    const viewKeys = shape.unreachable === true ? honest : shape.members;
    const want = JSON.stringify(viewKeys.map((key) => keyHost(key).hostId).toSorted());
    const statuses = new Map<string, Status>();
    await mesh.until(
      `${shape.id}: every judge's view is ${JSON.stringify(viewKeys)}`,
      async () => {
        const seen = await Promise.all(judges.map((judge) => statusOf(judge)));
        for (const [index, judge] of judges.entries())
          statuses.set(
            judge.name,
            seen[index] ?? { sync: "", members: [], revoked: [], stuck: [], halvedUntil: undefined },
          );
        return seen.every((status) => JSON.stringify(status.members.map((member) => member.hostId)) === want);
      },
      MEMBERS_MS,
    );
    return { deliveries: sessions.map((session) => session.kind), judgements, sightings: await watch.stop(), statuses };
  } finally {
    for (const session of sessions) session.close();
  }
}
