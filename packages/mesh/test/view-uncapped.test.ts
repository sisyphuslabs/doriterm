import { describe, expect, test } from "bun:test";
import { viewOf, viewOfRecords } from "../src/view/engine.ts";
import { admit, type Draft, found, name, revoke, withChainNumbers } from "./fixtures/records.ts";
import { signScenario } from "./fixtures/signed.ts";

const MEMBERS = 40;
const key = (i: number): string => `K${i}`;

/**
 * K0 founds and admits K1..K12 (13 members); K12, the 13th member, admits K13..K39 (40 members). Then K39 renames
 * itself, K20 revokes K30, K30 admits K40 after its own revoke, and Z, a key nobody admitted, admits K41.
 */
function bigFlatMesh(): Draft[] {
  const drafts: Draft[] = [found("f", key(0))];
  const last = (): string => drafts.at(-1)?.id ?? "f";
  for (let i = 1; i < MEMBERS; i++) {
    const by = i <= 12 ? key(0) : key(12);
    drafts.push(admit(`a${i}`, by, key(i), [last()]));
  }
  drafts.push(name("rename", key(39), key(39), [last()], "k39-renamed"));
  drafts.push(revoke("revoke", key(20), [key(30)], [last()]));
  drafts.push(admit("late", key(30), key(40), [last()]));
  drafts.push(admit("stranger", "Z", key(41), [last()]));
  return drafts;
}

const records = withChainNumbers(bigFlatMesh());
const expected = Array.from({ length: MEMBERS }, (_, i) => key(i)).filter((k) => k !== key(30));

describe("a mesh has no member cap", () => {
  test("every governed key is a member, and members past the 12th sign records that count", () => {
    const view = viewOfRecords(records);
    expect(view.members).toEqual(expected);
    expect(view.admitter.get(key(39))).toBe(key(12));
    expect(view.name.get(key(39))).toBe("k39-renamed");
    expect(view.revoked).toEqual([key(30)]);
  });

  test("a revoked member's later admit and an unadmitted key's admit stay void", () => {
    const view = viewOfRecords(records);
    expect(view.eff.has("late")).toBe(false);
    expect(view.eff.has("stranger")).toBe(false);
    expect(view.members).not.toContain(key(40));
    expect(view.members).not.toContain(key(41));
  });

  test("the same mesh as signed records gives the same members through viewOf", () => {
    const signed = signScenario(records);
    const view = viewOf(signed.records);
    expect([...view.members].map((pub) => signed.nameOfKey.get(pub))).toEqual(expected);
    expect([...view.revoked].map((pub) => signed.nameOfKey.get(pub))).toEqual([key(30)]);
  });
});
