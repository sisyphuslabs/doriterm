// The adversarial colluder rows (the model's scenarios-adversarial.ts A4, A4r, A5, A6): two revoked keys that vouch for
// each other against the honest members, in one --compromised batch or revoked separately.

import { ack, admit, type Draft, found, revoke } from "./records.ts";
import type { Scenario } from "./scenario.ts";

const base3 = (): Draft[] => [found("F", "A"), admit("aB", "A", "B", ["F"]), admit("aX", "A", "X", ["aB"])];

function chain(by: string, keys: readonly string[], start: string): Draft[] {
  let prev = start;
  return keys.map((k) => {
    const r = admit(`a${k}`, by, k, [prev]);
    prev = r.id;
    return r;
  });
}

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

export const colluderScenarios: readonly Scenario[] = [
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
];
