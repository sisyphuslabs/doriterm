import { hashOf, memberCardOf, parseRecord, viewOf, type CardBody, type Signed } from "@doriface/mesh";
import type { MemberTarget } from "../connection/settings.ts";
import type { ReadmitSubject } from "@doriface/mesh";

export interface BundleView {
  readonly phase: "empty" | "joined" | "removed";
  readonly mesh: string;
  readonly records: readonly Signed[];
  readonly machines: readonly MemberTarget[];
  readonly clients: readonly CardBody[];
  readonly self: CardBody | undefined;
  readonly replacedAt?: number;
  readonly readmissions?: readonly ReadmitSubject[];
}

export interface ClientKeys {
  readonly signPub: string;
  readonly devicePub: string;
}

/** Uses governing cards and the view's current keys; a client survives only while its admitter is a machine. */
export function memberCards(records: readonly Signed[]): readonly CardBody[] {
  const view = viewOf(records);
  const byHash = new Map(records.map((record) => [hashOf(record), record]));
  const members = new Map<string, CardBody>();
  for (const signPub of view.members) {
    const record = byHash.get(view.governing.get(signPub) ?? "");
    const body = record === undefined ? undefined : parseRecord(record);
    const card = body === undefined ? undefined : memberCardOf(body);
    if (card !== undefined) {
      members.set(signPub, {
        ...card,
        name: view.name.get(signPub) ?? card.name,
        noisePub: view.noise.get(signPub) ?? card.noisePub,
      });
    }
  }
  const machines = [...members.values()].filter((card) => card.kind !== "client");
  const clients = [...members.values()].filter(
    (card) => card.kind === "client" && machines.some((machine) => machine.signPub === view.admitter.get(card.signPub)),
  );
  return [...machines, ...clients];
}

export function bundleView(records: readonly Signed[], mesh: string, keys: ClientKeys): BundleView {
  const cards = memberCards(records);
  const machines = cards.filter((card) => card.kind !== "client");
  const clients = cards.filter((card) => card.kind === "client");
  const self = clients.find(
    (card) => card.signPub === keys.signPub && card.devicePub === keys.devicePub && card.noisePub === keys.devicePub,
  );
  const view = viewOf(records);
  const replacedAt = keys === undefined ? undefined : view.restoredOld?.get(keys.signPub);
  const readmissions = records.flatMap((record) => {
    const body = parseRecord(record);
    return body?.type === "readmit" && view.governing.get(body.subject.signPub) === hashOf(record)
      ? [body.subject]
      : [];
  });
  return {
    phase: records.length === 0 ? "empty" : self === undefined ? "removed" : "joined",
    mesh,
    records,
    self,
    clients,
    ...(replacedAt === undefined ? {} : { replacedAt }),
    ...(readmissions.length === 0 ? {} : { readmissions }),
    machines:
      self === undefined
        ? []
        : machines.map((card) => ({
            hostId: card.hostId,
            hostName: card.name,
            hostKey: card.noisePub,
            directUrl: "",
          })),
  };
}
