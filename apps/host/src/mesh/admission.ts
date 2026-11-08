import { type CardBody, cardOf, parseRecord, type Signed, verifyCard } from "@doriface/mesh";
import { JoinRefused } from "@doriface/mesh/join";
import type { AuthorizeIndex } from "./authorize-index.ts";
import type { DeviceStore } from "../state/devices.ts";

const ANOTHER_KEY = "this host is a member with another Noise key: rekey it, or revoke and re-admit it";
const KEY_HELD = "this Noise key is another mesh member's";
export const CLIENT_REMOVED = "this browser was removed from the mesh: join again with an invite";

/** A current client refreshes; a client signing key with any previous admit is never admitted again. */
export function isRejoin(index: AuthorizeIndex | undefined, card: CardBody, records: readonly Signed[]): boolean {
  if (
    [card.noisePub, card.devicePub].some(
      (key) => key !== undefined && index?.namedByAnother(key, card.signPub) === true,
    )
  )
    throw new JoinRefused(KEY_HELD);
  const holder = card.kind === "client" ? index?.client(card.devicePub ?? "") : index?.member(card.noisePub);
  if (holder?.signPub === card.signPub) return true;
  if (holder !== undefined) throw new JoinRefused(KEY_HELD);
  if (index?.isMember(card.signPub) === true) throw new JoinRefused(ANOTHER_KEY);
  if (
    card.kind === "client" &&
    records.some((record) => {
      const body = parseRecord(record);
      const signed = body?.type === "admit" ? cardOf(body) : undefined;
      return signed !== undefined && verifyCard(signed)?.signPub === card.signPub;
    })
  )
    throw new JoinRefused(CLIENT_REMOVED);
  return false;
}

/** Paired keys and clients this machine admitted share one devices budget, with migrated devices counted once. */
export function clientDeviceCount(index: AuthorizeIndex | undefined, devices: DeviceStore, admitter: string): number {
  return new Set([
    ...devices.list().map((device) => device.clientStaticPub),
    ...(index?.clients() ?? [])
      .filter((client) => client.admitter === admitter)
      .flatMap((client) => (client.devicePub === undefined ? [] : [client.devicePub])),
  ]).size;
}
