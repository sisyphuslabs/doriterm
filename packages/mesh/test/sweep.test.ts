import { expect, test } from "bun:test";
import { noAttackerWin, type Outcome, stickiness } from "./sim/properties.ts";
import { rng } from "./sim/world.ts";

const SWEEP_SEEDS = [1, 2, 3, 4, 5, 7, 11, 13] as const;
const RUNS = 250;

test("M-11s: the 8-seed sweep (single key, batch, meshes of 2, M-12) has 0 histories beyond the disclosed limits", () => {
  let histories = 0;
  let beyond = 0;
  for (const seed of SWEEP_SEEDS) {
    const rows: readonly Outcome[] = [
      stickiness(rng(seed), RUNS, { compromised: false, minMembers: 3, joinerAcks: false }),
      stickiness(rng(seed + 100), RUNS, { compromised: true, minMembers: 3, joinerAcks: false }),
      stickiness(rng(seed + 200), RUNS, { compromised: false, minMembers: 2, joinerAcks: false }),
      noAttackerWin(rng(seed + 300), 200),
    ];
    for (const row of rows) {
      histories += row.tried;
      beyond += row.bad;
    }
    console.log(`sweep seed ${seed}: ${rows.map((row) => row.report).join(" | ")}`);
  }
  console.log(`sweep total: ${histories} histories, ${beyond} beyond the disclosed limits`);
  expect(histories).toBeGreaterThan(0);
  expect(beyond).toBe(0);
}, 300_000);
