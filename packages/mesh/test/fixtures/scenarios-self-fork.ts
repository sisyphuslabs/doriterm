// A signer that equivocated at counter n - 1 and then signs n with both branches in prev (a merged self-fork). The
// contract's amended notation: valid(pred(x)) holds only if EVERY own record with counter n - 1 in past(x) is valid,
// so the view never depends on which branch an implementation meets first. Mutation `any-pred` (one valid branch is
// enough) fails SF1 and SF1b; making a merged self-fork invalid outright fails SF2.

import { ack, admit, type Draft, found, name, rekey } from "./records.ts";
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
    records: [...base(), ack("kB1", "B", ["aB"]), ack("kB2", "B", ["aB"]), rekey("rB", "B", ["kB1", "kB2"], "B-key-2")],
    expectMembers: ["A", "B"],
    expectRevoked: [],
    expectNoise: { B: "B-key-2" },
  },
];
