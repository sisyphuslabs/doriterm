import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaimOwner, claimBlock, ownerFor, releaseClaims, takeOver, takeOverHolding } from "./port-claims.ts";

const MODULE = join(import.meta.dir, "port-claims.ts");

function claimsDir(): string {
  return mkdtempSync(join(tmpdir(), "port-claims-"));
}

/** An owner on this computer whose runner has exited: a run killed before its teardown. */
function goneOwner(run: string): ClaimOwner {
  const child = Bun.spawnSync(["true"]);
  return { ...ownerFor(run), pid: child.pid };
}

function seed(dir: string, base: number, count: number, owner: ClaimOwner): void {
  for (let port = base; port < base + count; port++) writeFileSync(join(dir, `port-${port}`), JSON.stringify(owner));
}

const claimNames = (dir: string): string[] => readdirSync(dir).filter((name) => /^port-\d+$/u.test(name));

// Two runs that picked at the same moment can both find the same ports free; the claim decides which run gets them
// (#2943).
test("a block that overlaps one a live run holds is refused, whole, naming its holder, and the holder keeps its claims", () => {
  const dir = claimsDir();
  try {
    const first = ownerFor("a");
    expect(claimBlock(17_000, 34, first, dir)).toEqual({ ok: true });
    expect(claimBlock(17_020, 34, ownerFor("b"), dir)).toEqual({ ok: false, holder: first });
    expect(claimNames(dir).length).toBe(34);
    expect(claimBlock(17_034, 34, ownerFor("b"), dir)).toEqual({ ok: true });
    expect(claimNames(dir).length).toBe(68);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run's claims go back at its teardown, and only its own", () => {
  const dir = claimsDir();
  try {
    expect(claimBlock(18_000, 34, ownerFor("a"), dir).ok).toBe(true);
    expect(claimBlock(18_034, 34, ownerFor("b"), dir).ok).toBe(true);
    releaseClaims(ownerFor("a"), dir);
    expect(claimNames(dir).length).toBe(34);
    expect(claimBlock(18_000, 34, ownerFor("c"), dir).ok).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claims a killed run left are swept by the next claim, wherever it picks, and its own block is taken over", () => {
  const dir = claimsDir();
  try {
    seed(dir, 19_000, 34, goneOwner("killed"));
    seed(dir, 21_000, 34, goneOwner("killed-too"));
    expect(claimBlock(19_000, 34, ownerFor("next"), dir).ok).toBe(true);
    // The other dead block is gone too, though this run did not pick it.
    expect(claimNames(dir).length).toBe(34);
    releaseClaims(ownerFor("next"), dir);
    expect(claimNames(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim from an earlier boot is dead though its pid runs again, and one from another computer is never taken", () => {
  const dir = claimsDir();
  try {
    // This very process's pid, from another boot: the pid runs again, the runner that claimed is long gone.
    const rebooted = { ...ownerFor("before-reboot"), boot: "an-earlier-boot" };
    seed(dir, 22_000, 4, rebooted);
    expect(claimBlock(22_000, 4, ownerFor("now"), dir).ok).toBe(true);
    const elsewhere = { ...goneOwner("elsewhere"), host: "another-computer" };
    seed(dir, 23_000, 4, elsewhere);
    expect(claimBlock(23_000, 4, ownerFor("now"), dir)).toEqual({ ok: false, holder: elsewhere });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A laptop waking or NTP stepping the clock moves "now" but not the boot: a live runner's claims stay live.
test("a live run's claims stay live when the clock is stepped", () => {
  const dir = claimsDir();
  const live = ownerFor("live");
  expect(claimBlock(26_000, 4, live, dir).ok).toBe(true);
  // The clock steps a day after the claim was made, and before another run judges it.
  const stepped = spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
  try {
    expect(claimBlock(26_000, 4, ownerFor("other"), dir)).toEqual({ ok: false, holder: live });
  } finally {
    stepped.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a killed run's half-made claim and takeover lock are swept, and a live run's lock is left alone", () => {
  const dir = claimsDir();
  try {
    const killed = goneOwner("killed");
    writeFileSync(join(dir, `port-27000.${killed.run}.${killed.pid}.draft`), JSON.stringify(killed));
    writeFileSync(join(dir, "port-27001.takeover"), JSON.stringify(killed));
    writeFileSync(join(dir, "port-27002.takeover"), JSON.stringify(ownerFor("taking-over")));
    expect(claimBlock(28_000, 1, ownerFor("next"), dir).ok).toBe(true);
    expect(readdirSync(dir).toSorted()).toEqual(["port-27002.takeover", "port-28000"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The interleaving behind two runs both winning (#2943 review): run A reads a stale claim; before A removes it, run B
// takes it over and claims the port; A must then leave B's claim alone, not remove whatever now has the name.
test("a takeover removes only the stale claim it read, never a live claim that replaced it meanwhile", () => {
  const dir = claimsDir();
  try {
    const file = join(dir, "port-25000");
    const stale = goneOwner("killed");
    seed(dir, 25_000, 1, stale);
    // A has read `stale`; B took the port over first.
    takeOver(file, stale, ownerFor("b"));
    expect(claimBlock(25_000, 1, ownerFor("b"), dir).ok).toBe(true);
    takeOver(file, stale, ownerFor("a"));
    expect((JSON.parse(readFileSync(file, "utf8")) as ClaimOwner).run).toBe("b");
    expect(claimBlock(25_000, 1, ownerFor("a"), dir)).toEqual({ ok: false, holder: ownerFor("b") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The reaper interleaving (#2953 review): L holds the takeover lock and has read the stale claim; a reaper moves L's
// lock away, run M takes the free name. L must then back off: leave M's lock, and leave the claim for M to judge.
test("a holder whose takeover lock was taken from it backs off: it removes neither the newcomer's lock nor the claim", () => {
  const dir = claimsDir();
  try {
    const file = join(dir, "port-29000");
    const lock = `${file}.takeover`;
    const stale = goneOwner("killed");
    seed(dir, 29_000, 1, stale);
    const [l, m] = [ownerFor("l"), ownerFor("m")];
    // M now holds the lock L had taken.
    writeFileSync(lock, JSON.stringify(m));
    takeOverHolding(lock, file, stale, l);
    expect((JSON.parse(readFileSync(lock, "utf8")) as ClaimOwner).run).toBe("m");
    expect((JSON.parse(readFileSync(file, "utf8")) as ClaimOwner).run).toBe("killed");
    // M, still holding it, takes the stale claim over and lets the lock go.
    takeOverHolding(lock, file, stale, m);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tomb a killed reaper left is swept", () => {
  const dir = claimsDir();
  try {
    const killed = goneOwner("reaper");
    writeFileSync(join(dir, `port-30000.takeover.${killed.run}.${killed.pid}.reaped`), JSON.stringify(goneOwner("x")));
    expect(claimBlock(30_001, 1, ownerFor("next"), dir).ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["port-30001"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A worker that claims the stale block once the gate opens, as one of several runs started at the same instant. */
const RACER = `
import { claimBlock, ownerFor } from ${JSON.stringify(MODULE)};
self.onmessage = (event) => {
  const { gate, run, dir } = event.data;
  postMessage({ ready: true });
  Atomics.wait(new Int32Array(gate), 0, 0);
  postMessage({ run, ok: claimBlock(24000, 4, ownerFor(run), dir).ok });
};
`;

/** Runs `count` racers over the stale block in `dir`, released together once all are waiting at the gate. */
async function race(count: number, dir: string, script: string): Promise<{ run: string; ok: boolean }[]> {
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from({ length: count }, () => new Worker(script));
  const settled = workers.map((worker, index) => {
    const ready = Promise.withResolvers<void>();
    const result = Promise.withResolvers<{ run: string; ok: boolean }>();
    worker.addEventListener("message", (event: MessageEvent) => {
      if (event.data.ready === true) ready.resolve();
      else result.resolve(event.data);
    });
    worker.postMessage({ gate, run: `run-${index}`, dir }, []);
    return { ready: ready.promise, result: result.promise };
  });
  await Promise.all(settled.map((one) => one.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(settled.map((one) => one.result));
  for (const worker of workers) worker.terminate();
  return results;
}

// Runs started together over a block a killed run left: each finds the claims stale, and each would take them over.
// The takeover is exclusive, so at most one comes out owning the block, and every claim names that one (#2943 review).
test("of runs that take over the same stale block at the same instant, at most one wins, and the claims name it", async () => {
  const scripts = claimsDir();
  const script = join(scripts, "racer.ts");
  writeFileSync(script, RACER);
  try {
    for (let trial = 0; trial < 40; trial += 1) {
      const dir = claimsDir();
      try {
        seed(dir, 24_000, 4, goneOwner("killed"));
        // oxlint-disable-next-line no-await-in-loop -- each trial's runs race each other, not the next trial's
        const results = await race(8, dir, script);
        const winners = results.filter((result) => result.ok).map((result) => result.run);
        expect(winners.length).toBeLessThanOrEqual(1);
        const named = new Set(
          claimNames(dir).map((name) => (JSON.parse(readFileSync(join(dir, name), "utf8")) as ClaimOwner).run),
        );
        if (winners.length === 1) expect([...named]).toEqual(winners);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(scripts, { recursive: true, force: true });
  }
});
