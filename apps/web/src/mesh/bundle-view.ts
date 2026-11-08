import { cardOf, hashOf, parseRecord, verifyCard, viewOf, type CardBody, type Signed } from "@doriface/mesh";
import type { MemberTarget } from "../connection/settings.ts";

export interface BundleView {
  readonly phase: "empty" | "joined" | "removed";
  readonly mesh: string;
  readonly records: readonly Signed[];
  readonly machines: readonly MemberTarget[];
  readonly clients: readonly CardBody[];
  readonly self: CardBody | undefined;
}

export interface ClientKeys {
  readonly signPub: string;
  readonly devicePub: string;
}

/** Uses governing cards and the view's current keys; a client survives only while its admitter is a machine. */
export function bundleView(records: readonly Signed[], mesh: string, keys: ClientKeys): BundleView {
  const view = viewOf(records);
  const byHash = new Map(records.map((record) => [hashOf(record), record]));
  const members = new Map<string, CardBody>();
  for (const signPub of view.members) {
    const record = byHash.get(view.governing.get(signPub) ?? "");
    const body = record === undefined ? undefined : parseRecord(record);
    const signed = body === undefined ? undefined : cardOf(body);
    const card = signed === undefined ? undefined : verifyCard(signed);
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
    (card) =>
      card.kind === "client" &&
      machines.some((machine) => machine.signPub === view.admitter.get(card.signPub)),
  );
  const self = clients.find(
    (card) => card.signPub === keys.signPub && card.devicePub === keys.devicePub && card.noisePub === keys.devicePub,
  );
  return {
    phase: records.length === 0 ? "empty" : self === undefined ? "removed" : "joined",
    mesh,
    records,
    self,
    clients,
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
