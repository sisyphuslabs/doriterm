import { describe, expect, test } from "bun:test";
import { agreement, noAttackerWin, stickiness } from "./sim/properties.ts";
import { rng } from "./sim/world.ts";

const SEED = 20261103;
const SLOW = 120_000;

describe("random properties at seed 20261103", () => {
  test(
    "M-3a: the engine equals the independent oracle on 150 seeded adversarial DAGs",
    () => {
      const out = agreement(rng(SEED), 150);
      expect(out.bad).toBe(0);
    },
    SLOW,
  );

  const rows = [
    { label: "single key", seed: SEED + 2, compromised: false, minMembers: 3, joinerAcks: false },
    { label: "--compromised batch", seed: SEED + 3, compromised: true, minMembers: 3, joinerAcks: false },
    { label: "single key, meshes of 2 included", seed: SEED + 2, compromised: false, minMembers: 2, joinerAcks: false },
    {
      label: "meshes of 2, the joiner acks its admission",
      seed: SEED + 2,
      compromised: false,
      minMembers: 2,
      joinerAcks: true,
    },
  ] as const;
  for (const row of rows) {
    test(
      `M-11 (${row.label}): 0 takeovers and 0 decidable removals after an acked revoke`,
      () => {
        const out = stickiness(rng(row.seed), 250, row);
        console.log(`M-11 ${row.label}: ${out.report}`);
        expect(out.tried).toBeGreaterThan(0);
        expect(out.bad).toBe(0);
      },
      SLOW,
    );
  }

  test(
    "M-12: two separately revoked colluders never win outside residual 2",
    () => {
      const out = noAttackerWin(rng(SEED + 4), 200);
      console.log(`M-12: ${out.report}`);
      expect(out.tried).toBeGreaterThan(0);
      expect(out.bad).toBe(0);
    },
    SLOW,
  );
});
