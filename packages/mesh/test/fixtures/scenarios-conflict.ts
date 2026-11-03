// The adversarial conflict rows (the model's scenarios-adversarial.ts A1-A7b, A10, A14-A21): backdating, mutual and
// mass revokes, colluders, admit races, lineage re-admits and early forks, each with the one view R3 gives.

import { ack, admit, type Draft, found, name, revoke } from "./records.ts";
import type { Scenario } from "./scenario.ts";

const base3 = (): Draft[] => [found("F", "A"), admit("aB", "A", "B", ["F"]), admit("aX", "A", "X", ["aB"])];
const base4 = (): Draft[] => [...base3(), admit("aC", "A", "C", ["aX"])];

function chain(by: string, keys: readonly string[], start: string): Draft[] {
  let prev = start;
  return keys.map((k) => {
    const r = admit(`a${k}`, by, k, [prev]);
    prev = r.id;
    return r;
  });
}

const backdated = (p: string): Draft[] => [
  ...base3(),
  revoke("vX_byB", "B", ["X"], ["aX"]),
  name("nB_byA", "A", "B", ["vX_byB"]),
  revoke(`${p}vB_byX`, "X", ["B"], ["aX"]),
  revoke(`${p}vA_byX`, "X", ["A"], ["aX"]),
  admit(`${p}aZ_byX`, "X", "Z", ["aX"]),
];

const colluders = (honest: readonly Draft[]): Draft[] => [
  ...honest,
  admit("aY_byX", "X", "Y", ["aX"]),
  revoke("vXY_byB", "B", ["X", "Y"], ["aY_byX"]),
  ack("kA", "A", ["vXY_byB"]),
];
const colluderTail = (): Draft[] => [
  admit("aZ_byX", "X", "Z", ["aY_byX"]),
  ack("kY", "Y", ["aZ_byX"]),
  revoke("vB_byX", "X", ["B"], ["kY"]),
  ack("kY2", "Y", ["vB_byX"]),
  revoke("vA_byY", "Y", ["A"], ["kY2"]),
  ack("kX", "X", ["vA_byY"]),
];

const earlyFork = (last: Draft): Draft[] => [
  { ...found("F", "A"), n: 1 },
  { ...admit("aD", "A", "D", ["F"]), n: 2 },
  { ...admit("aC", "A", "C", ["aD"]), n: 3 },
  { ...revoke("vA_byC", "C", ["A"], ["aC"]), n: 1 },
  { ...ack("kD", "D", ["vA_byC"]), n: 1 },
  last,
];

const admitRace = (): Draft[] => [
  ...base4(),
  admit("aD", "A", "D", ["aC"]),
  admit("aZ_byX", "X", "Z", ["aD"]),
  ack("kC", "C", ["aZ_byX"]),
];

export const conflictScenarios: readonly Scenario[] = [
  {
    id: "A1",
    title: "mutual revoke, A acked B's revoke before X's arrived: X's counter-revoke falls (1:0)",
    records: [
      ...base3(),
      revoke("vX_byB", "B", ["X"], ["aX"]),
      ack("kA", "A", ["vX_byB"]),
      revoke("vB_byX", "X", ["B"], ["aX"]),
    ],
    expectMembers: ["A", "B"],
    expectRevoked: ["X"],
  },
  {
    id: "A2",
    title: "backdating after every member acked: X revokes everyone, admits Z, Z acks; Z cannot vote",
    records: [
      ...base4(),
      revoke("vX_byB", "B", ["X"], ["aC"]),
      ack("kA", "A", ["vX_byB"]),
      ack("kC", "C", ["vX_byB"]),
      revoke("vALL_byX", "X", ["A", "B", "C"], ["aC"]),
      admit("aZ_byX", "X", "Z", ["aC"]),
      ack("kZ", "Z", ["aZ_byX"]),
      name("nB_byX", "X", "B", ["aC"], "pwned"),
    ],
    expectMembers: ["A", "B", "C"],
    expectRevoked: ["X"],
    expectName: { B: "b" },
  },
  {
    id: "A3",
    title: "sleeper after revoke --compromised of X and the D it admitted",
    records: [
      found("F", "A"),
      admit("aX", "A", "X", ["F"]),
      admit("aD_byX", "X", "D", ["aX"]),
      revoke("vXD_byA", "A", ["X", "D"], ["aD_byX"]),
      admit("aX_byD", "D", "X", ["vXD_byA"]),
      admit("aX_byD2", "D", "X", ["aD_byX"]),
    ],
    expectMembers: ["A"],
    expectRevoked: ["D", "X"],
  },
  {
    id: "A4",
    title: "two colluders revoked in one --compromised batch vouch for each other; three honest members (2:1)",
    records: [
      ...colluders([
        found("F", "A"),
        admit("aB", "A", "B", ["F"]),
        admit("aC", "A", "C", ["aB"]),
        admit("aX", "A", "X", ["aC"]),
      ]),
      ack("kC", "C", ["vXY_byB"]),
      ...colluderTail(),
    ],
    expectMembers: ["A", "B", "C"],
    expectRevoked: ["X", "Y"],
  },
  {
    id: "A4r",
    title: "the same with two honest members: the batch-mate Y does not vote on B's revoke (1:0)",
    records: [...colluders(base3()), ...colluderTail()],
    expectMembers: ["A", "B"],
    expectRevoked: ["X", "Y"],
  },
  {
    id: "A5",
    title: "two colluders revoked separately, three honest members (2:1)",
    records: [
      found("F", "A"),
      ...chain("A", ["B", "C", "X", "Y"], "F"),
      revoke("vX_byB", "B", ["X"], ["aY"]),
      revoke("vY_byC", "C", ["Y"], ["vX_byB"]),
      ack("kA", "A", ["vY_byC"]),
      revoke("vB_byX", "X", ["B"], ["aY"]),
      admit("aZ_byX", "X", "Z", ["aY"]),
      ack("kY", "Y", ["vB_byX", "aZ_byX"]),
      revoke("vC_byY", "Y", ["C"], ["kY"]),
      ack("kX", "X", ["vC_byY"]),
    ],
    expectMembers: ["A", "B", "C"],
    expectRevoked: ["X", "Y"],
  },
  {
    id: "A6",
    title: "two colluders revoked separately, two honest members (symmetric)",
    records: [
      found("F", "A"),
      ...chain("A", ["B", "X", "Y"], "F"),
      revoke("vX_byB", "B", ["X"], ["aY"]),
      revoke("vY_byA", "A", ["Y"], ["vX_byB"]),
      ack("kB", "B", ["vY_byA"]),
      revoke("vB_byX", "X", ["B"], ["aY"]),
      admit("aZ_byX", "X", "Z", ["aY"]),
      ack("kY", "Y", ["vB_byX", "aZ_byX"]),
      revoke("vA_byY", "Y", ["A"], ["kY"]),
      ack("kX", "X", ["vA_byY"]),
    ],
    expectMembers: ["A", "B"],
    expectRevoked: ["X", "Y"],
    residual: { members: ["Z"], revoked: ["A", "B", "X", "Y"] },
  },
  {
    id: "A7",
    title: "genuine admit race: C and D acked X's admit of Z before B's revoke of X reached them (2:1)",
    records: [
      ...admitRace(),
      ack("kD", "D", ["aZ_byX"]),
      revoke("vX_byB", "B", ["X"], ["aD"]),
      ack("kA", "A", ["vX_byB"]),
    ],
    expectMembers: ["A", "B", "C", "D", "Z"],
    expectRevoked: ["X"],
    expectAdmitter: { Z: "X" },
  },
  {
    id: "A7b",
    title: "admit race where one member saw the admit first (1:1): only strictly more voters defeat it",
    records: [...admitRace(), revoke("vX_byB", "B", ["X"], ["aD"]), ack("kA", "A", ["vX_byB"])],
    expectMembers: ["A", "B", "C", "D", "Z"],
    expectRevoked: ["X"],
    expectAdmitter: { Z: "X" },
  },
  {
    id: "A10",
    title: "lineage re-admit: after --compromised, an honest member re-admits X, which re-admits D",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      admit("aX", "A", "X", ["aB"]),
      admit("aD_byX", "X", "D", ["aX"]),
      revoke("vXD_byB", "B", ["X", "D"], ["aD_byX"]),
      ack("kA", "A", ["vXD_byB"]),
      admit("aX2_byA", "A", "X", ["kA"]),
      admit("aD2_byX", "X", "D", ["aX2_byA"]),
    ],
    expectMembers: ["A", "B", "X", "D"],
    expectRevoked: [],
    expectAdmitter: { X: "A", D: "X" },
  },
  {
    id: "A14",
    title: "N = 2 mutual revoke: no third party, both stand",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      revoke("vB_byA", "A", ["B"], ["aB"]),
      revoke("vA_byB", "B", ["A"], ["aB"]),
    ],
    expectMembers: [],
    expectRevoked: ["A", "B"],
  },
  {
    id: "A15",
    title: "a revoked member writes after merging its own revoke: not authorized",
    records: [...base3(), revoke("vX_byB", "B", ["X"], ["aX"]), admit("aZ_byX", "X", "Z", ["vX_byB"])],
    expectMembers: ["A", "B"],
    expectRevoked: ["X"],
  },
  {
    id: "A16",
    title: "an admit of X concurrent with X's revoke does not re-admit it",
    records: [...base4(), revoke("vX_byB", "B", ["X"], ["aC"]), admit("aX2_byC", "C", "X", ["aC"])],
    expectMembers: ["A", "B", "C"],
    expectRevoked: ["X"],
  },
  {
    id: "A17",
    title: "a vote from a record its signer could not write does not count",
    records: [
      found("F", "A"),
      ...chain("A", ["B", "C", "X", "Y"], "F"),
      revoke("vY_byC", "C", ["Y"], ["aY"]),
      revoke("vX_byB", "B", ["X"], ["aY"]),
      ack("kA", "A", ["vX_byB"]),
      revoke("vB_byX", "X", ["B"], ["aY"]),
      ack("wY", "Y", ["vB_byX", "vY_byC"]),
    ],
    expectMembers: ["A", "B", "C"],
    expectRevoked: ["X", "Y"],
  },
  {
    id: "A18",
    title: "hash grinding: R2 with X's records named to sort first",
    records: backdated("0"),
    expectMembers: ["A", "B"],
    expectRevoked: ["X"],
  },
  {
    id: "A19",
    title: "the 'revoke everyone' lever: an honest admit acked before X's backdated mass revoke (2:0)",
    records: [
      ...base4(),
      admit("aN_byA", "A", "N", ["aC"]),
      ack("kB", "B", ["aN_byA"]),
      revoke("vX_byC", "C", ["X"], ["kB"]),
      ack("kA", "A", ["vX_byC"]),
      ack("kB2", "B", ["kA"]),
      revoke("vALL_byX", "X", ["A", "B", "C", "N"], ["aC"]),
    ],
    expectMembers: ["A", "B", "C", "N"],
    expectRevoked: ["X"],
  },
  {
    id: "A20",
    title: "early fork: the revoked founder signs an admit reusing a counter from before it admitted D",
    records: earlyFork({ ...admit("aZ_byA", "A", "Z", ["F"]), n: 2 }),
    expectMembers: ["C", "D"],
    expectRevoked: ["A"],
  },
  {
    id: "A21",
    title: "early fork with a skipped counter: an admit whose own chain has a gap is not valid",
    records: earlyFork({ ...admit("aZ_byA", "A", "Z", ["F"]), n: 5 }),
    expectMembers: ["C", "D"],
    expectRevoked: ["A"],
  },
];
