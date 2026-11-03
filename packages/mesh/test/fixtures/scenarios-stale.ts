// The rev2 review's stale-fork shapes (P1, P1b, P2, P6, P7, P7b, P13): forks where the revoked key's last own record
// leaves no independent witness, the N = 2 family included. R3 fails closed on the undecidable ones and decides the
// ones an ack pins (P7b).

import { ack, admit, found, name, revoke } from "./records.ts";
import type { Scenario } from "./scenario.ts";

export const staleForkScenarios: readonly Scenario[] = [
  {
    id: "P1",
    title: "N = 2: A revokes B; B backdates admit(Z) before the revoke",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      revoke("vB_byA", "A", ["B"], ["aB"]),
      admit("xZ_byB", "B", "Z", ["aB"]),
    ],
    expectMembers: ["A"],
    expectRevoked: ["B"],
  },
  {
    id: "P1b",
    title: "N = 2 as P1, and B also backdates revoke(A)",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      revoke("vB_byA", "A", ["B"], ["aB"]),
      admit("xZ_byB", "B", "Z", ["aB"]),
      revoke("xA_byB", "B", ["A"], ["xZ_byB"]),
    ],
    expectMembers: ["A"],
    expectRevoked: ["B"],
    residual: { members: [], revoked: ["A", "B"] },
  },
  {
    id: "P2",
    title: "revoked at N = 2, the mesh grew to 4 with acks; B backdates admit(Z) and revoke(A)",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      revoke("vB_byA", "A", ["B"], ["aB"]),
      admit("aC", "A", "C", ["vB_byA"]),
      ack("kC", "C", ["aC"]),
      admit("aD", "A", "D", ["kC"]),
      ack("kD", "D", ["aD"]),
      admit("xZ_byB", "B", "Z", ["aB"]),
      revoke("xA_byB", "B", ["A"], ["xZ_byB"]),
    ],
    expectMembers: ["A", "C", "D"],
    expectRevoked: ["B"],
    residual: { members: [], revoked: ["A", "B"] },
  },
  {
    id: "P6",
    title: "an honest admit accused by a backdated revoke whose only witness is silent",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      admit("aG", "A", "G", ["aB"]),
      revoke("vB_byG", "G", ["B"], ["aG"]),
      revoke("xA_byB", "B", ["A"], ["aB"]),
    ],
    expectMembers: [],
    expectRevoked: ["A", "B"],
  },
  {
    id: "P7",
    title: "as P6, A wrote once after the revoke, B never acked G's admission",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      admit("aG", "A", "G", ["aB"]),
      revoke("vB_byG", "G", ["B"], ["aG"]),
      revoke("xA_byB", "B", ["A"], ["aB"]),
      name("nG_byA", "A", "G", ["vB_byG"], "g2"),
    ],
    expectMembers: ["A", "G"],
    expectRevoked: ["B"],
    residual: { members: [], revoked: ["A", "B"] },
  },
  {
    id: "P7b",
    title: "as P7, B acked G's admission before its compromise",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      admit("aG", "A", "G", ["aB"]),
      ack("kB", "B", ["aG"]),
      revoke("vB_byG", "G", ["B"], ["kB"]),
      revoke("xA_byB", "B", ["A"], ["kB"]),
      name("nG_byA", "A", "G", ["vB_byG"], "g2"),
    ],
    expectMembers: ["A", "G"],
    expectRevoked: ["B"],
    expectName: { G: "g2" },
  },
  {
    id: "P13",
    title: "N = 2 mint-voter: D revokes A; A backdates admit(Z1); Z1 revokes D; A testifies for Z1",
    records: [
      found("F", "A"),
      admit("aD", "A", "D", ["F"]),
      ack("kD", "D", ["aD"]),
      revoke("vA_byD", "D", ["A"], ["kD"]),
      admit("xZ1_byA", "A", "Z1", ["aD"]),
      revoke("xD_byZ1", "Z1", ["D"], ["xZ1_byA"]),
      ack("xk_byA", "A", ["xD_byZ1"]),
    ],
    expectMembers: [],
    expectRevoked: ["A", "D"],
  },
];
