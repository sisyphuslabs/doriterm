// A signer that equivocated at counter n - 1 and then signs n with both branches in prev (a merged self-fork). The
// contract's amended notation: valid(pred(x)) holds only if EVERY own record with counter n - 1 in past(x) is valid,
// so the view never depends on which branch an implementation meets first. Mutation `any-pred` (one valid branch is
// enough) fails SF1 and SF1b; making a merged self-fork invalid outright fails SF2. SF3 and SF3b: an accuser that saw
// both branches of a fork sees the fork, whatever the order of its prev (mutation `one-per-counter`).

import { ack, admit, type Draft, found, name, rekey, revoke } from "./records.ts";
import type { Scenario } from "./scenario.ts";

const base = (): Draft[] => [found("F", "A"), admit("aB", "A", "B", ["F"])];
const invalidName = name("nQ", "B", "Q", ["aB"]);

export const selfForkScenarios: readonly Scenario[] = [
  {
    id: "SF1",
    title: "B merges its own fork of an invalid name and a valid ack: the rekey that merges them is not valid",
    records: [...base(), invalidName, ack("kB", "B", ["aB"]), rekey("rB", "B", ["nQ", "kB"], "B-key-2")],
    expectMembers: ["A", "B"],
    expectRevoked: [],
    expectNoise: { B: "B-key" },
  },
  {
    id: "SF1b",
    title: "the same with prev in the other order: the result does not depend on which branch is met first",
    records: [...base(), invalidName, ack("kB", "B", ["aB"]), rekey("rB", "B", ["kB", "nQ"], "B-key-2")],
    expectMembers: ["A", "B"],
    expectRevoked: [],
    expectNoise: { B: "B-key" },
  },
  {
    id: "SF2",
    title: "B merges its own fork of two valid acks: every branch is valid, so the rekey is",
    records: [
      ...base(),
      ack("kB1", "B", ["aB"]),
      ack("kB2", "B", ["aB", "F"]),
      rekey("rB", "B", ["kB1", "kB2"], "B-key-2"),
    ],
    expectMembers: ["A", "B"],
    expectRevoked: [],
    expectNoise: { B: "B-key-2" },
  },
  ...(["SF3", "SF3b"] as const).map((id, i) => ({
    id,
    title: `A's revoke of B saw both of B's records at counter 1 (prev in ${i === 0 ? "one" : "the other"} order): B's revoke of A from one branch is a fork`,
    records: [
      ...base(),
      ack("b1", "B", ["aB"]),
      ack("b2", "B", ["aB", "F"]),
      revoke("vB", "A", ["B"], i === 0 ? ["b1", "b2"] : ["b2", "b1"]),
      revoke("x", "B", ["A"], ["b1"]),
    ],
    expectMembers: ["A"],
    expectRevoked: ["B"],
  })),
];
