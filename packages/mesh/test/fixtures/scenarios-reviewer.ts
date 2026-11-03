// The design reviewer's counterexamples R1-R5b (mesh-design.md section 13, the model's scenarios-reviewer.ts), record
// for record, with the one view R3 gives each. R4's forged admit is offered at the door after the records are stored.

import { admit, type Draft, forgedAdmit, found, name, revoke } from "./records.ts";
import type { Scenario } from "./scenario.ts";

const base3 = (): Draft[] => [found("F", "A"), admit("aB", "A", "B", ["F"]), admit("aX", "A", "X", ["aB"])];
const base4 = (): Draft[] => [...base3(), admit("aC", "A", "C", ["aX"])];

export const reviewerScenarios: readonly Scenario[] = [
  {
    id: "R1",
    title: "mutual revoke, nobody else wrote anything: the only voter saw neither first, both revokes stand",
    records: [...base3(), revoke("vX_byB", "B", ["X"], ["aX"]), revoke("vB_byX", "X", ["B"], ["aX"])],
    expectMembers: ["A"],
    expectRevoked: ["B", "X"],
  },
  {
    id: "R2",
    title: "backdating by a revoked member: A wrote after B's revoke, so X's backdated records each lose",
    records: [
      ...base3(),
      revoke("vX_byB", "B", ["X"], ["aX"]),
      name("nB_byA", "A", "B", ["vX_byB"]),
      revoke("vB_byX", "X", ["B"], ["aX"]),
      revoke("vA_byX", "X", ["A"], ["aX"]),
      admit("aZ_byX", "X", "Z", ["aX"]),
    ],
    expectMembers: ["A", "B"],
    expectRevoked: ["X"],
    expectName: { B: "b-2" },
  },
  {
    id: "R3",
    title: "a sleeper re-admits a revoked member after a plain revoke: one view, the lineage shows it",
    records: [
      found("F", "A"),
      admit("aX", "A", "X", ["F"]),
      admit("aD_byX", "X", "D", ["aX"]),
      revoke("vX_byA", "A", ["X"], ["aD_byX"]),
      admit("aX_byD", "D", "X", ["vX_byA"]),
    ],
    expectMembers: ["A", "D", "X"],
    expectRevoked: [],
    expectAdmitter: { D: "X", X: "D" },
  },
  {
    id: "R4",
    title: "Noise-key substitution: an admit whose card C never signed is refused at the door",
    records: [found("F", "A"), admit("aC", "A", "C", ["F"], "C-real"), admit("aX", "A", "X", ["aC"])],
    batch: [forgedAdmit("aC_byX", "X", "C", ["aX"], "ATTACKER")],
    refusals: ["bad card"],
    after: [revoke("vX_byA", "A", ["X"], ["aX"])],
    expectMembers: ["A", "C"],
    expectRevoked: ["X"],
    expectNoise: { C: "C-real" },
  },
  {
    id: "R5a",
    title: "M-4 set A: X revokes B, no conflict",
    records: [...base4(), revoke("vB_byX", "X", ["B"], ["aC"])],
    expectMembers: ["A", "C", "X"],
    expectRevoked: ["B"],
  },
  {
    id: "R5b",
    title: "M-4 set A plus C's concurrent revoke of X: neither voter saw either first, both revokes stand",
    records: [...base4(), revoke("vB_byX", "X", ["B"], ["aC"]), revoke("vX_byC", "C", ["X"], ["aC"])],
    expectMembers: ["A", "C"],
    expectRevoked: ["B", "X"],
  },
];
