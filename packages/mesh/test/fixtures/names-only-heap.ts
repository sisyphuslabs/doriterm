// The heap a ViewCache keeps after one cold view of a mesh whose every later record is a name, at the cap. Run as its
// own process (bun test/fixtures/names-only-heap.ts), so no other test's garbage or live objects move the reading;
// it prints {"heldMb": n}.

import { heapStats } from "bun:jsc";
import { MAX_MESH_MEMBERS, MAX_RECORDS } from "../../src/records/types.ts";
import { ViewCache, viewOfRecords } from "../../src/view/engine.ts";
import { admit, type Draft, found, name, withChainNumbers } from "./records.ts";

/** A full mesh whose every later record is a name: each record's past is a context of its own. */
export function namesOnly(records: number): Draft[] {
  const drafts: Draft[] = [found("f", "K0")];
  const last = (): string => drafts.at(-1)?.id ?? "f";
  for (let i = 1; i < MAX_MESH_MEMBERS; i++) drafts.push(admit(`a${i}`, "K0", `K${i}`, [last()]));
  while (drafts.length < records) {
    const k = `K${drafts.length % MAX_MESH_MEMBERS}`;
    drafts.push(name(`n${drafts.length}`, k, k, [last()], `${k}-${drafts.length}`));
  }
  return drafts;
}

const heapMb = (): number => {
  Bun.gc(true);
  return heapStats().heapSize / 1e6;
};

if (import.meta.main) {
  const records = withChainNumbers(namesOnly(MAX_RECORDS));
  const base = heapMb();
  const cache = new ViewCache();
  const members = viewOfRecords(records, cache).members.length;
  const heldMb = heapMb() - base;
  console.log(JSON.stringify({ heldMb, members }));
  cache.clear();
}
