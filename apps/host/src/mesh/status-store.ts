import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import {
  type CardBody,
  type FailClosed,
  failClosedOf,
  hashOf,
  parseRecord,
  type RecordBody,
  type Signed,
  verifyCard,
  type View,
  ViewCache,
  viewOf,
} from "@doriface/mesh";
import type { MeshStatus } from "@doriface/protocol";
import { isRecord } from "../state/files.ts";
import type { MeshFile } from "../state/mesh-file.ts";
import { ownN } from "../state/mesh-tx.ts";
import type { MeshStore } from "../state/mesh.ts";
import type { MeshLiveFacts, MeshHooks } from "./host-hooks.ts";
import type { LocalFacts, MeshSources, RevocationFact } from "./status-sources.ts";
import { hostIdOfKey, meshStatus } from "./status.ts";
import { witnessFacts } from "./witness.ts";

// `mesh status` on the running host (design 8.6): the stored part of PR 7's MeshSources read from mesh.json and its
// view, the live part from the mesh hooks.

interface Parsed {
  readonly hash: string;
  readonly body: RecordBody;
}

const parsedOf = (records: readonly Signed[]): readonly Parsed[] =>
  records.flatMap((record) => {
    const body = parseRecord(record);
    return body === undefined ? [] : [{ hash: hashOf(record), body }];
  });

function cardsOf(parsed: readonly Parsed[], key: string): readonly CardBody[] {
  return parsed.flatMap(({ body }) => {
    const card = body.subject !== undefined && "card" in body.subject ? verifyCard(body.subject.card) : undefined;
    return card?.signPub === key ? [card] : [];
  });
}

/** The latest name record about `key`, if any (design 7.5). */
function lastNameOf(parsed: readonly Parsed[], key: string): string | undefined {
  return parsed
    .flatMap(({ body }) => {
      const subject = body.subject;
      return subject !== undefined && "name" in subject && subject.signPub === key ? [subject.name] : [];
    })
    .at(-1);
}

/** The revoke behind every revoked key: its effective revokes' signers, the latest one's reason and time. */
function revocationsOf(parsed: readonly Parsed[], view: View): ReadonlyMap<string, RevocationFact> {
  const facts = new Map<string, RevocationFact>();
  for (const key of view.revoked) {
    const naming = parsed.filter(({ body }) => {
      const subject = body.subject;
      return body.type === "revoke" && subject !== undefined && "signPubs" in subject && subject.signPubs.includes(key);
    });
    const revokes = naming.filter(({ hash }) => view.eff.has(hash));
    const latest = revokes.at(-1)?.body;
    const card = cardsOf(parsed, key).at(-1);
    if (latest?.subject === undefined || !("reason" in latest.subject) || card === undefined) continue;
    const renamed = lastNameOf(parsed, key);
    facts.set(key, {
      name: renamed ?? card.name,
      noisePub: card.noisePub,
      by: [...new Set(revokes.map(({ body }) => body.by))],
      reason: latest.subject.reason,
      at: isoOf(latest.at),
    });
  }
  return facts;
}

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** A record's `at` is the signer's display time, in any form it chose: an ISO instant when it reads as one. */
function isoOf(value: string | undefined): string | null {
  const time = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localOf(file: MeshFile, view: View, self: string, live: MeshLiveFacts): LocalFacts {
  const keys = [...view.members, ...view.revoked];
  const byHostId = new Map(keys.map((key) => [hostIdOfKey(key), key]));
  const localNames = new Map(
    Object.entries(file.local).flatMap(([hostId, entry]) => {
      const key = byHostId.get(hostId);
      const name = field(entry, "name");
      return key === undefined || typeof name !== "string" ? [] : [[key, name] as const];
    }),
  );
  const noticed = new Map(
    Object.entries(file.notices).flatMap(([key, entry]) => {
      const seen = dateOf(field(entry, "seenAt"));
      return seen === null ? [] : [[key, seen] as const];
    }),
  );
  return {
    meshId: file.meshId,
    self,
    generation: file.generation,
    records: file.records.length,
    counter: { file: file.selfN, mesh: Math.max(ownN(file.records, self), live.peerCounter) },
    localNames,
    noticed,
    readOnlyUntil: dateOf(file.readOnlyUntil),
    possiblyRevoked: live.possiblyRevoked,
  };
}

export function meshSourcesOf(
  file: MeshFile,
  view: View,
  self: string,
  live: MeshLiveFacts,
  cache: ViewCache = new ViewCache(),
): MeshSources {
  const parsed = parsedOf(file.records);
  /** The founder is admitted by its own found record; PR 7's ViewFacts gives it no admitter. */
  const foundHash = parsed.find(({ body }) => body.type === "found")?.hash;
  /** A host its own view no longer holds lists the view's members only, and says it is possibly revoked. */
  const inView = view.members.has(self);
  return {
    view: {
      members: view.members,
      revoked: view.revoked,
      noise: view.noise,
      admitter: new Map([...view.admitter].filter(([key]) => view.governing.get(key) !== foundHash)),
      name: view.name,
    },
    revocations: revocationsOf(parsed, view),
    failClosed: failClosedFor(failClosedOf(file.records, cache), self),
    local: { ...localOf(file, view, self, live), possiblyRevoked: live.possiblyRevoked || !inView },
    pending: live.pending,
    peers: live.peers,
    lines: live.lines,
    budget: live.budget,
    witnessPool: (subject) => witnessFacts(file.records, view, self, subject, cache),
  };
}

/**
 * The fail-closed removals as this host reports them (design 3.7). At 0:0 the record set cannot tell the sides
 * apart, but this host knows it is honest: a revoked key that removed it is the culprit, so the mirror facts, by this
 * host or by the keys that culprit removed, are the honest side's own revokes and are left out.
 */
function failClosedFor(facts: readonly FailClosed[], self: string): readonly FailClosed[] {
  const culprits = facts.filter((fact) => fact.removed.includes(self));
  if (culprits.length === 0) return facts;
  // A key a culprit removed is honest only when it removed this host itself in no fact: two culprits can name each other.
  const culpritKeys = new Set(culprits.map((fact) => fact.revokedKey));
  const honest = new Set([self, ...culprits.flatMap((fact) => fact.removed).filter((key) => !culpritKeys.has(key))]);
  return facts.filter((fact) => !honest.has(fact.revokedKey));
}

/** This host's mesh status now, or undefined while it is in no mesh: the host's `meshStatus`. */
export function storedMeshStatus(store: MeshStore, identity: HostIdentity, hooks: MeshHooks): MeshStatus | undefined {
  const file = store.read();
  if (file === undefined) return undefined;
  const self = base64urlEncode(identity.sign.publicKey);
  const cache = new ViewCache();
  return meshStatus(meshSourcesOf(file, viewOf(file.records, cache), self, hooks.live(), cache), new Date());
}
