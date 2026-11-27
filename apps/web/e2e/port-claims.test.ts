import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimBlock, releaseRun } from "./port-claims.ts";

function claimsDir(): string {
  return mkdtempSync(join(tmpdir(), "port-claims-"));
}

/** A pid that has exited: a run whose runner is gone. */
function deadPid(): number {
  const child = Bun.spawnSync(["true"]);
  return child.pid;
}

// Two runs that picked at the same moment can both find the same ports free; the claim decides which run gets them
// (#2943).
test("a block that overlaps one a live run holds is refused, whole, and leaves the live run's claims as they were", () => {
  const dir = claimsDir();
  try {
    const first = { run: "a", pid: process.pid };
    const second = { run: "b", pid: process.pid };
    expect(claimBlock(17_000, 34, first, dir)).toBe(true);
    expect(claimBlock(17_020, 34, second, dir)).toBe(false);
    // All or none: the second run holds none of the ports it tried, and the first still holds all 34.
    expect(readdirSync(dir).length).toBe(34);
    expect(claimBlock(17_034, 34, second, dir)).toBe(true);
    expect(readdirSync(dir).length).toBe(68);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run's claims go back at its teardown, and only its own", () => {
  const dir = claimsDir();
  try {
    expect(claimBlock(18_000, 34, { run: "a", pid: process.pid }, dir)).toBe(true);
    expect(claimBlock(18_034, 34, { run: "b", pid: process.pid }, dir)).toBe(true);
    releaseRun("a", dir);
    expect(readdirSync(dir).length).toBe(34);
    expect(claimBlock(18_000, 34, { run: "c", pid: process.pid }, dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim whose runner has exited is taken over, so a killed run does not hold its ports for good", () => {
  const dir = claimsDir();
  try {
    expect(claimBlock(19_000, 34, { run: "gone", pid: deadPid() }, dir)).toBe(true);
    expect(claimBlock(19_000, 34, { run: "next", pid: process.pid }, dir)).toBe(true);
    releaseRun("next", dir);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
