// Every M-5 row (P1-P13, R1-R5b, A1-A21 with A4r and A7b, SF1, SF1b, SF2) as the record set a host stores for it.

import type { Rec } from "../../src/view/dag.ts";
import { withChainNumbers } from "./records.ts";
import type { Scenario } from "./scenario.ts";
import { cardScenarios } from "./scenarios-cards.ts";
import { colluderScenarios } from "./scenarios-colluders.ts";
import { conflictScenarios } from "./scenarios-conflict.ts";
import { lineageScenarios } from "./scenarios-lineage.ts";
import { reviewerScenarios } from "./scenarios-reviewer.ts";
import { selfForkScenarios } from "./scenarios-self-fork.ts";
import { staleForkScenarios } from "./scenarios-stale.ts";

export const SCENARIOS: readonly Scenario[] = [
  ...staleForkScenarios,
  ...lineageScenarios,
  ...reviewerScenarios,
  ...conflictScenarios,
  ...colluderScenarios,
  ...cardScenarios,
  ...selfForkScenarios,
];

/** What a host stores for a scenario: its records and what it wrote after the door refused the batch. */
export const stored = (s: Scenario): Rec[] => withChainNumbers([...s.records, ...(s.after ?? [])]);
