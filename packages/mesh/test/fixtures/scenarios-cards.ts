// The adversarial rows about cards, keys and mesh size (the model's scenarios-adversarial.ts A8, A9, A11, A12, A13):
// a key change needs the member's own signature, a card admits once and only its subject can sign it, and a mesh has
// no member cap (#806). A `batch` row's records are offered at the real door, as signed records.

import { admit, admitWithCard, card, type Draft, foreignRekey, forgedAdmit, found, rekey, revoke } from "./records.ts";
import type { Scenario } from "./scenario.ts";

const oldCardC = card("C", "A", "C-key", "nC-old");

function chain(prefix: string, by: string, keys: readonly string[], start: string): Draft[] {
  let prev = start;
  return keys.map((k) => {
    const r = admit(`${prefix}${k}`, by, k, [prev]);
    prev = r.id;
    return r;
  });
}

export const cardScenarios: readonly Scenario[] = [
  {
    id: "A8",
    title: "a Noise-key change needs the member's own signature: a rekey of C signed by A is refused",
    records: [found("F", "A"), admit("aC", "A", "C", ["F"]), rekey("rC", "C", ["aC"], "C-key-2")],
    batch: [foreignRekey("rC_byA", "A", "C", ["rC"], "A-chosen")],
    refusals: ["rekey of another member"],
    expectMembers: ["A", "C"],
    expectRevoked: [],
    expectNoise: { C: "C-key-2" },
  },
  {
    id: "A9",
    title: "an admit of a current member carrying another Noise key is not type-valid",
    records: [
      found("F", "A"),
      admit("aC", "A", "C", ["F"]),
      admit("aX", "A", "X", ["aC"]),
      admit("aC2_byX", "X", "C", ["aX"], "C-new"),
    ],
    expectMembers: ["A", "C", "X"],
    expectRevoked: [],
    expectNoise: { C: "C-key" },
  },
  {
    id: "A9b",
    title: "an admit of a new key carrying a current member's Noise key (a twin) is not type-valid (#90)",
    records: [found("F", "A"), admit("aB", "A", "B", ["F"]), admit("aT", "A", "T", ["aB"], "B-key")],
    expectMembers: ["A", "B"],
    expectRevoked: [],
    expectNoise: { B: "B-key" },
  },
  {
    id: "A9c",
    title: "a rekey onto another current member's Noise key is not type-valid (#90)",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      admit("aC", "A", "C", ["aB"]),
      rekey("rB", "B", ["aC"], "C-key"),
    ],
    expectMembers: ["A", "B", "C"],
    expectRevoked: [],
    expectNoise: { B: "B-key", C: "C-key" },
  },
  {
    id: "A9d",
    title:
      "twins written in concurrent branches both pass type_ok; after B's revoke the view lists T with B's key, which hosts refuse (#90)",
    records: [
      found("F", "A"),
      admit("aX", "A", "X", ["F"]),
      admit("aB", "A", "B", ["aX"]),
      admit("aT", "X", "T", ["aX"], "B-key"),
      revoke("vB", "A", ["B"], ["aB", "aT"]),
    ],
    expectMembers: ["A", "X", "T"],
    expectRevoked: ["B"],
    expectNoise: { T: "B-key" },
  },
  {
    id: "A11",
    title: "a forged card re-binding an ex-member's identity to an attacker key is refused",
    records: [
      found("F", "A"),
      admit("aC", "A", "C", ["F"]),
      admit("aX", "A", "X", ["aC"]),
      revoke("vC_byA", "A", ["C"], ["aX"]),
    ],
    batch: [forgedAdmit("aC_byX", "X", "C", ["vC_byA"], "ATTACKER")],
    refusals: ["bad card"],
    expectMembers: ["A", "X"],
    expectRevoked: ["C"],
  },
  {
    id: "A12",
    title: "a replay of an ex-member's old card cannot re-admit it: a card's nonce admits once",
    records: [
      found("F", "A"),
      admitWithCard("aC", "A", oldCardC, ["F"]),
      admit("aX", "A", "X", ["aC"]),
      revoke("vC_byA", "A", ["C"], ["aX"]),
    ],
    batch: [admitWithCard("aC_again", "A", oldCardC, ["vC_byA"])],
    refusals: ["card nonce reused"],
    expectMembers: ["A", "X"],
    expectRevoked: ["C"],
  },
  {
    id: "A13",
    title:
      "partition heal past twelve: both sides of a partition admitted six, and all fourteen are members everywhere",
    records: [
      found("F", "A"),
      admit("aB", "A", "B", ["F"]),
      ...chain("p", "A", ["N1", "N2", "N3", "N4", "N5", "N6"], "aB"),
      ...chain("q", "B", ["M1", "M2", "M3", "M4", "M5", "M6"], "aB"),
    ],
    expectMembers: ["A", "B", "N1", "N2", "N3", "N4", "N5", "N6", "M1", "M2", "M3", "M4", "M5", "M6"],
    expectRevoked: [],
  },
];
