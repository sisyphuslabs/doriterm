import { describe, expect, test } from "bun:test";
import { hashOf, parseRecord, type Signed } from "@doriface/mesh";
import type { MeshStore } from "../state/mesh.ts";
import { mergeBatch } from "./merge.ts";
import { headsOfRecords, meshOf, peer, Signer, storeOf } from "./testing/mesh-peers.ts";

const [a, b, c] = [peer("a"), peer("b"), peer("c")];

function atB() {
  const { records, meshId } = meshOf([a, b]);
  const store = storeOf(b, records);
  return { store, deps: { store, identity: b.machine.identity, meshId }, founder: new Signer(a, records) };
}

const recordsOf = (store: MeshStore): readonly Signed[] => store.read()?.records ?? [];
const headsAt = (store: MeshStore): readonly string[] => headsOfRecords(recordsOf(store));
const acksBy = (store: MeshStore, who: string): readonly Signed[] =>
  recordsOf(store).filter((record) => {
    const body = parseRecord(record);
    return body?.type === "ack" && body.by === who;
  });

describe("automatic acks (S-3, section 5.5)", () => {
  test("a merged admission is acked in the same store transaction, the ack naming it", () => {
    const { store, deps, founder } = atB();
    const admit = founder.admit(c, headsAt(store));
    let transactions = 0;
    const counted: Pick<MeshStore, "transact" | "read"> = {
      read: () => store.read(),
      transact: (fn) => {
        transactions += 1;
        return store.transact(fn);
      },
    };
    const result = mergeBatch({ ...deps, store: counted }, [admit]);
    const after = store.read();
    expect(transactions).toBe(1);
    const ack = result.ack;
    if (ack === undefined) throw new Error("no ack");
    expect(after?.records.map(hashOf)).toEqual(expect.arrayContaining([hashOf(admit), hashOf(ack)]));
    expect(parseRecord(ack)?.prev).toContain(hashOf(admit));
  });

  test("acks and names are never acked", () => {
    const { store, deps, founder } = atB();
    mergeBatch(deps, [founder.ack(headsAt(store))]);
    mergeBatch(deps, [founder.name(headsAt(store), "a2")]);
    expect(acksBy(store, b.signPub)).toEqual([]);
  });

  test("a member the merged view revoked writes nothing", () => {
    const { store, deps, founder } = atB();
    const result = mergeBatch(deps, [founder.revoke(headsAt(store), b)]);
    expect(result.ack).toBeUndefined();
    expect(acksBy(store, b.signPub)).toEqual([]);
  });

  test("more heads than one record can name are folded by acks first, every one within the door's limits", () => {
    const { store, deps, founder } = atB();
    const start = headsAt(store);
    mergeBatch(
      deps,
      Array.from({ length: 70 }, () => founder.ack(start)),
    );
    expect(headsAt(store).length).toBe(70);
    mergeBatch(deps, [founder.admit(c, start)]);
    expect(headsAt(store).length).toBeLessThanOrEqual(1);
    const own = acksBy(store, b.signPub);
    expect(own.length).toBeGreaterThan(1);
    for (const record of own) expect(parseRecord(record)?.prev.length).toBeLessThanOrEqual(64);
  });
});

describe("the dangling pool (S-1)", () => {
  test("a record whose past is missing is held out of the view, wanted, and stored once its past arrives", () => {
    const { store, deps, founder } = atB();
    const parent = founder.admit(c, headsAt(store));
    const child = founder.admit(peer("e"), [hashOf(parent)]);
    const held = mergeBatch(deps, [child]);
    expect(held.added).toEqual([]);
    expect(held.wanted).toEqual([hashOf(parent)]);
    expect(held.view.members.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(store.read()?.dangling.map(hashOf)).toEqual([hashOf(child)]);

    const healed = mergeBatch(deps, [parent]);
    expect(healed.added.slice(0, 2).map(hashOf)).toEqual([hashOf(parent), hashOf(child)]);
    expect(healed.view.members.map((entry) => entry.name)).toEqual(["a", "b", "c", "e"]);
    expect(store.read()?.dangling).toEqual([]);
  });

  test("a record by a signer whose admission has not arrived is held, not refused, and stored after it", () => {
    const { store, deps, founder } = atB();
    const admit = founder.admit(c, headsAt(store));
    const byC = new Signer(c, [...recordsOf(store), admit]).name([hashOf(admit)], "c2");
    const held = mergeBatch(deps, [byC]);
    expect(held.refused).toEqual([]);
    expect(store.read()?.dangling.map(hashOf)).toEqual([hashOf(byC)]);
    mergeBatch(deps, [admit]);
    expect(recordsOf(store).map(hashOf)).toEqual(expect.arrayContaining([hashOf(admit), hashOf(byC)]));
  });
});
