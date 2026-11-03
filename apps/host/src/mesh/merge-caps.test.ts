import { describe, expect, test } from "bun:test";
import { MAX_DANGLING, MAX_RECORDS, mergeBatch } from "./merge.ts";
import { FakeSigner, fakeRules, hashOfRecord, MemoryFile, meshOf, member } from "./testing/fake-mesh.ts";
import type { MeshRecord } from "./upstream.ts";

const [a, b] = [member("a"), member("b")];

function chainOf(size: number): { file: MemoryFile; founder: FakeSigner } {
  const records: MeshRecord[] = [...meshOf([a, b])];
  const founder = new FakeSigner(a, 2);
  let last = hashOfRecord(records[1] ?? records[0] ?? { body: "", sig: "" });
  while (records.length < size) {
    const record = founder.name([last], `n${records.length}`);
    records.push(record);
    last = hashOfRecord(record);
  }
  return { file: new MemoryFile(records), founder };
}

describe("the record and dangling caps (section 3.3)", () => {
  test("the dangling pool keeps the newest 256 held records", () => {
    const { file, founder } = chainOf(2);
    const deps = { file, rules: fakeRules, signer: new FakeSigner(b, 1) };
    const held = Array.from({ length: MAX_DANGLING + 44 }, (_, i) => founder.name([`missing-${i}`], `h${i}`));
    const result = mergeBatch(deps, held);
    expect(result.added).toEqual([]);
    expect(file.read().dangling.map(hashOfRecord)).toEqual(held.slice(-MAX_DANGLING).map(hashOfRecord));
  });

  test("a full log refuses the next record", () => {
    const { file, founder } = chainOf(MAX_RECORDS);
    const deps = { file, rules: fakeRules, signer: new FakeSigner(b, 1) };
    const extra = founder.name(fakeRules.headsOf(file.read().records), "one too many");
    const result = mergeBatch(deps, [extra]);
    expect(result.refused).toEqual([{ hash: hashOfRecord(extra), reason: `mesh log full (${MAX_RECORDS})` }]);
    expect(file.read().records.length).toBe(MAX_RECORDS);
  });

  test("an admission that fills the log is not acked past the cap", () => {
    const { file, founder } = chainOf(MAX_RECORDS - 1);
    const deps = { file, rules: fakeRules, signer: new FakeSigner(b, 1) };
    const result = mergeBatch(deps, [founder.admit(member("c"), fakeRules.headsOf(file.read().records))]);
    expect(result.ack).toBeUndefined();
    expect(file.read().records.length).toBe(MAX_RECORDS);
  });
});
