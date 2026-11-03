import { describe, expect, test } from "bun:test";
import { mergeBatch } from "./merge.ts";
import { FakeSigner, fakeRules, hashOfRecord, MemoryFile, meshOf, member } from "./testing/fake-mesh.ts";

const [a, b, c] = ["a", "b", "c"].map(member) as [
  ReturnType<typeof member>,
  ReturnType<typeof member>,
  ReturnType<typeof member>,
];

function atB(): { file: MemoryFile; deps: Parameters<typeof mergeBatch>[0]; founder: FakeSigner } {
  const base = meshOf([a, b]);
  const file = new MemoryFile(base);
  return { file, deps: { file, rules: fakeRules, signer: new FakeSigner(b, 1) }, founder: new FakeSigner(a, 2) };
}

const headsOf = (file: MemoryFile) => fakeRules.headsOf(file.read().records);
const acksBy = (file: MemoryFile, who: string) =>
  file.read().records.filter((record) => {
    const header = fakeRules.headerOf(record);
    return header.type === "ack" && header.by === who;
  });

describe("automatic acks (S-3)", () => {
  test("a merged admission is acked in the same transaction, the ack naming it", () => {
    const { file, deps, founder } = atB();
    const admit = founder.admit(c, headsOf(file));
    const before = file.commits.length;
    const result = mergeBatch(deps, [admit]);
    expect(file.commits.length - before).toBe(1);
    const committed = file.commits.at(-1)?.records.map(hashOfRecord) ?? [];
    const ack = result.ack;
    if (ack === undefined) throw new Error("no ack");
    expect(committed).toContain(hashOfRecord(admit));
    expect(committed).toContain(hashOfRecord(ack));
    expect(fakeRules.headerOf(ack).prev).toContain(hashOfRecord(admit));
  });

  test("acks and names are never acked", () => {
    const { file, deps, founder } = atB();
    mergeBatch(deps, [founder.sign({ type: "ack", prev: headsOf(file) })]);
    mergeBatch(deps, [founder.name(headsOf(file), "a2")]);
    expect(acksBy(file, b.signPub)).toEqual([]);
  });

  test("a member the merged view revoked writes nothing", () => {
    const { file, deps, founder } = atB();
    const revoke = founder.sign({ type: "revoke", prev: headsOf(file), signPubs: [b.signPub], reason: "revoke" });
    const result = mergeBatch(deps, [revoke]);
    expect(result.ack).toBeUndefined();
    expect(acksBy(file, b.signPub)).toEqual([]);
  });

  test("more than 64 heads are folded by acks first, so no record names more than 64", () => {
    const { file, deps, founder } = atB();
    const start = headsOf(file);
    const wide = Array.from({ length: 70 }, () => founder.sign({ type: "ack", prev: start }));
    mergeBatch(deps, wide);
    mergeBatch(deps, [founder.admit(c, start)]);
    expect(headsOf(file).length).toBeLessThanOrEqual(1);
    const own = acksBy(file, b.signPub);
    expect(own.length).toBeGreaterThan(1);
    for (const record of own) expect(fakeRules.headerOf(record).prev.length).toBeLessThanOrEqual(64);
  });
});

describe("the dangling pool (S-1)", () => {
  test("a record whose past is missing is held out of the view, wanted, and stored once its past arrives", () => {
    const { file, deps, founder } = atB();
    const parent = founder.admit(c, headsOf(file));
    const child = founder.admit(member("e"), [hashOfRecord(parent)]);
    const held = mergeBatch(deps, [child]);
    expect(held.added).toEqual([]);
    expect(held.wanted).toEqual([hashOfRecord(parent)]);
    expect(held.view.members.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(file.read().dangling.map(hashOfRecord)).toEqual([hashOfRecord(child)]);

    const healed = mergeBatch(deps, [parent]);
    expect(healed.added.slice(0, 2).map(hashOfRecord)).toEqual([hashOfRecord(parent), hashOfRecord(child)]);
    expect(healed.view.members.map((entry) => entry.name)).toEqual(["a", "b", "c", "e"]);
    expect(file.read().dangling).toEqual([]);
  });
});
