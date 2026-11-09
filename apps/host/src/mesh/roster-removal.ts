import { parseRecord, type Signed } from "@doriface/mesh";
import type { AuthorizeIndex } from "./authorize-index.ts";

/** Why a removed member's second roster session is refused while its first still runs (#1493). */
export const REMOVED_READING = "this removed member already reads its removal";

/** A key whose member was removed and that names no current client: its roster session only reads that removal. */
export const removedKey = (index: AuthorizeIndex | undefined, key: string): boolean =>
  index?.client(key) === undefined && index?.removed(key) === true;

/**
 * What a removed member may read on the roster stream: the records up to the last revoke that names it, in the order
 * this machine stored them (each after the records it depends on), and nothing signed later (design 10.3).
 */
export function untilRemoval(records: readonly Signed[], signPub: string): readonly Signed[] {
  const last = records.findLastIndex((record) => {
    const subject = parseRecord(record)?.subject;
    return subject !== undefined && "signPubs" in subject && subject.signPubs.includes(signPub);
  });
  return records.slice(0, last + 1);
}
