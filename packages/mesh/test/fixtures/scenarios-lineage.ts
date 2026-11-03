// The rev2 review's lineage and chain shapes (P3, P4, P5, P8-P12): two-deep mints, minted accusers, founder hubs,
// chain gaps and forks, and the batch-mate vote.

import { ack, admit, type Draft, found, revoke } from "./records.ts";
import type { Scenario } from "./scenario.ts";

/** A founds; A admits G, C; C admits B; G acks. G revokes B; A and C ack. */
const honest3 = (): Draft[] => [
  found("F", "A"),
  admit("aG", "A", "G", ["F"]),
  admit("aC", "A", "C", ["aG"]),
  admit("aB", "C", "B", ["aC"]),
  ack("kG", "G", ["aB"]),
  revoke("vB_byG", "G", ["B"], ["kG"]),
  ack("kA", "A", ["vB_byG"]),
  ack("kC", "C", ["vB_byG"]),
];

/** G founds, admits B then A; G revokes B; A acks (P8-P11 build on it). */
const hub = (bAcked: boolean): Draft[] => [
  found("F", "G"),
  admit("aB", "G", "B", ["F"]),
  admit("aA", "G", "A", ["aB"]),
  ...(bAcked ? [ack("kB", "B", ["aA"])] : []),
  revoke("vB_byG", "G", ["B"], [bAcked ? "kB" : "aA"]),
  ack("kA", "A", ["vB_byG"]),
];

export const lineageScenarios: readonly Scenario[] = [
  {
    id: "P3",
    title: "a two-deep mint silences the honest acks: B admits Z0, Z0 admits Z1, Z1 revokes A and C, B revokes G",
    records: [
      ...honest3(),
      admit("xZ0_byB", "B", "Z0", ["aB"]),
      admit("xZ1_byZ0", "Z0", "Z1", ["xZ0_byB"]),
      revoke("xAC_byZ1", "Z1", ["A", "C"], ["xZ1_byZ0"]),
      revoke("xG_byB", "B", ["G"], ["xAC_byZ1"]),
      ack("xk_byZ1", "Z1", ["xG_byB"]),
    ],
    expectMembers: ["A", "C", "G"],
    expectRevoked: ["B"],
  },
  {
    id: "P4",
    title: "B revokes A and C before its mint's revoke of G; B testifies for the mint",
    records: [
      ...honest3(),
      admit("xZ0_byB", "B", "Z0", ["aB"]),
      revoke("xAC_byB", "B", ["A", "C"], ["xZ0_byB"]),
      ack("xk_byB", "B", ["xAC_byB"]),
      revoke("xG_byZ0", "Z0", ["G"], ["xk_byB"]),
      revoke("xAGC_byB", "B", ["A", "G", "C"], ["xG_byZ0"]),
    ],
    expectMembers: ["A", "C", "G"],
    expectRevoked: ["B"],
  },
  {
    id: "P5",
    title: "a genuine mutual revoke seen first by one member",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      admit("aX", "A", "X", ["aB"]),
      revoke("vX_byB", "B", ["X"], ["aX"]),
      ack("kA", "A", ["vX_byB"]),
      revoke("vB_byX", "X", ["B"], ["aX"]),
    ],
    expectMembers: ["A", "B"],
    expectRevoked: ["X"],
  },
  {
    id: "P8",
    title: "founder hub: B mints Z0, which revokes A; B revokes G",
    records: [
      ...hub(false),
      admit("xZ0_byB", "B", "Z0", ["aB"]),
      revoke("xG_byB", "B", ["G"], ["xZ0_byB"]),
      revoke("xA_byZ0", "Z0", ["A"], ["xG_byB"]),
      ack("xk_byZ0", "Z0", ["xA_byZ0"]),
    ],
    expectMembers: [],
    expectRevoked: ["B", "G"],
  },
  {
    id: "P9",
    title: "as P8, but B acked A's admission before its compromise",
    records: [
      ...hub(true),
      admit("xZ0_byB", "B", "Z0", ["kB"]),
      revoke("xG_byB", "B", ["G"], ["xZ0_byB"]),
      revoke("xA_byZ0", "Z0", ["A"], ["xG_byB"]),
      ack("xk_byZ0", "Z0", ["xA_byZ0"]),
    ],
    expectMembers: ["A", "G"],
    expectRevoked: ["B"],
  },
  {
    id: "P10",
    title: "as P9, but B's backdated records skip its own last record (a chain gap)",
    records: [
      ...hub(true),
      { ...admit("xZ0_byB", "B", "Z0", ["aB"]), n: 2 },
      { ...revoke("xG_byB", "B", ["G"], ["xZ0_byB"]), n: 3 },
    ],
    expectMembers: ["A", "G"],
    expectRevoked: ["B"],
  },
  {
    id: "P11",
    title: "as P9, but B's backdated records reuse its last record's counter (a fork G saw)",
    records: [
      ...hub(true),
      { ...admit("xZ0_byB", "B", "Z0", ["aB"]), n: 1 },
      { ...revoke("xG_byB", "B", ["G"], ["xZ0_byB"]), n: 2 },
    ],
    expectMembers: ["A", "G"],
    expectRevoked: ["B"],
  },
  {
    id: "P12",
    title: "two colluders in one batch against two honest members",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      admit("aX", "A", "X", ["aB"]),
      admit("aY_byX", "X", "Y", ["aX"]),
      revoke("vXY_byB", "B", ["X", "Y"], ["aY_byX"]),
      ack("kA", "A", ["vXY_byB"]),
      admit("aZ_byX", "X", "Z", ["aY_byX"]),
      ack("kY", "Y", ["aZ_byX"]),
      revoke("vB_byX", "X", ["B"], ["kY"]),
      ack("kY2", "Y", ["vB_byX"]),
      revoke("vA_byY", "Y", ["A"], ["kY2"]),
      ack("kX", "X", ["vA_byY"]),
    ],
    expectMembers: ["A", "B"],
    expectRevoked: ["X", "Y"],
  },
];
