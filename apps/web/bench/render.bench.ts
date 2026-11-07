// The render bench (#670): N live panes (1, 15, 50 by default) in one tab, each pane's program writing the same fixed
// workload, measured from outside the app (Chromium's own metrics over CDP and a probe added before the page loads), so
// the same spec measures the last release's build and the candidate's. A second phase repeats the workload with the
// panes' tab not selected: the hidden-tab cost. One JSON file per pane count lands in BENCH_OUT.
import type { CDPSession, Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "../e2e/fixtures.ts";
import { clearLayout, seedLayout, type Tree } from "../e2e/layout-doc.ts";
import { hcOn } from "../e2e/machine-switch.ts";
import { type BenchRun, type Workload, frameStats, gridOf, workloadBytes } from "./render-stats.ts";

const PANES = (process.env["BENCH_PANES"] ?? "1,15,50").split(",").map(Number);
const BUILD = process.env["BENCH_BUILD"] ?? "candidate";
const OUT = process.env["BENCH_OUT"] ?? join(import.meta.dirname, "..", "bench-out", "runs");

/** Ten lines of build-log-like output, a few in colour, about 800 bytes: what an agent's terminal streams. */
const CHUNK = Array.from({ length: 10 }, (_, line) => {
  const tag = line % 4 === 0 ? "\u001b[32mINFO\u001b[0m" : line % 4 === 1 ? "\u001b[33mWARN\u001b[0m" : "info";
  return `${tag} compiling packages/module-${line}/src/index.ts ${"=".repeat(24)} ${String(line * 37).padStart(4, "0")}`;
}).join("\n");
/** Every 100 ms for 6 s: 100 lines a second per pane. */
const WORKLOAD: Workload = { chunk: CHUNK, ticks: 60 };
const TICK_SECONDS = "0.1";

/**
 * Pane `pane`'s program: says it is ready, then for each phase waits for that phase's go file, writes the workload, its
 * end line and a done file, and keeps the terminal open. `sleep` is the only process it starts per tick.
 */
const program = (dir: string, pane: number): string[] => [
  "sh",
  "-c",
  [
    `d='${dir}'; i=${pane}; chunk=$(cat "$d/chunk")`,
    `printf 'bench-ready-%s\\n' "$i"`,
    "for phase in 1 2; do",
    `  while [ ! -e "$d/go$phase" ]; do sleep 0.05; done`,
    `  n=0; while [ "$n" -lt ${WORKLOAD.ticks} ]; do printf '%s\\n' "$chunk"; sleep ${TICK_SECONDS}; n=$((n+1)); done`,
    `  printf 'bench-end-%s-%s\\n' "$phase" "$i"; : > "$d/done$phase-$i"`,
    "done",
    "exec sleep 3600",
  ].join("\n"),
];

/** The page's frames and long tasks while recording, from a probe that runs before any of the app's scripts. */
async function addProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { recording: false, frames: [] as number[], longTasks: [] as number[] };
    Object.assign(window, { benchProbe: probe });
    const tick = (stamp: number): void => {
      if (probe.recording) probe.frames.push(stamp);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      if (probe.recording) for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
  });
}

const recording = (page: Page, on: boolean) =>
  page.evaluate((value) => {
    const probe = Reflect.get(window, "benchProbe") as { recording: boolean; frames: number[]; longTasks: number[] };
    if (value) {
      probe.frames.length = 0;
      probe.longTasks.length = 0;
    }
    probe.recording = value;
    return { frames: [...probe.frames], longTasks: [...probe.longTasks] };
  }, on);

type Metrics = Readonly<Record<string, number>>;
async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map((metric) => [metric.name, metric.value]));
}
/** Main-thread task time over wall time between two metric reads. */
const busy = (before: Metrics, after: Metrics): number =>
  ((after["TaskDuration"] ?? 0) - (before["TaskDuration"] ?? 0)) /
  ((after["Timestamp"] ?? 0) - (before["Timestamp"] ?? 0));

/** Resolves once every pane's program has written its done file for `phase`. */
async function producersDone(dir: string, panes: number, phase: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  const pending = new Set(Array.from({ length: panes }, (_, pane) => pane));
  while (pending.size > 0) {
    for (const pane of pending) if (existsSync(join(dir, `done${phase}-${pane}`))) pending.delete(pane);
    if (Date.now() > deadline) throw new Error(`${pending.size} panes' programs did not finish phase ${phase}`);
    // oxlint-disable-next-line no-await-in-loop -- the programs are other processes: their files are read again
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Resolves once every listed terminal shows `text`. */
const allShow = (page: Page, addresses: readonly string[], text: string) =>
  page.waitForFunction(
    ({ addresses: list, text: wanted }) =>
      list.every((address) =>
        (document.querySelector(`[data-terminal="${address}"]`)?.textContent ?? "").includes(wanted),
      ),
    { addresses, text },
    { polling: 50, timeout: 120_000 },
  );

/** The grid as a herdr-app split tree: one column of rows, each row its panes. */
function grid(addresses: readonly string[]): Tree[] {
  let next = 0;
  const rows = gridOf(addresses.length).map((width, row) => ({
    id: `bench-row-${row}`,
    axis: "row" as const,
    children: Array.from({ length: width }, () => {
      const at = next;
      next += 1;
      return { pane: `bench-p${at}`, terminal: addresses[at] ?? "" };
    }),
  }));
  return rows.length === 1 ? (rows[0]?.children ?? []) : [{ id: "bench-rows", axis: "column", children: rows }];
}

for (const panes of PANES) {
  test(`render bench: ${panes} panes`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    writeFileSync(join(dir, "chunk"), WORKLOAD.chunk);
    const started: string[] = [];
    try {
      for (let pane = 0; pane < panes; pane += 1) {
        const out = hcOn("host", ["run", "--bg", "--name", `bench-${pane}`, "--", ...program(dir, pane)]);
        started.push(String((JSON.parse(out) as { address: string }).address));
      }
      const idle = String(
        (
          JSON.parse(hcOn("host", ["run", "--bg", "--name", "bench-idle", "--", "sh", "-c", "exec sleep 3600"])) as {
            address: string;
          }
        ).address,
      );
      started.push(idle);
      const addresses = started.slice(0, panes);
      seedLayout([
        { id: "tb-bench", name: "bench", root: grid(addresses) },
        { id: "tb-idle", name: "idle", root: [{ pane: "bench-idle", terminal: idle }] },
      ]);
      await addProbe(page);
      await page.goto("/");
      await allShow(page, addresses, "bench-ready-");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");

      // Visible: every pane in view while the programs write.
      await recording(page, true);
      const before = await metrics(cdp);
      const go = performance.now();
      writeFileSync(join(dir, "go1"), "");
      await producersDone(dir, panes, 1);
      const produced = performance.now();
      await allShow(page, addresses, "bench-end-1-");
      const drawn = performance.now();
      const after = await metrics(cdp);
      const probe = await recording(page, false);
      // Heap and DOM nodes after a full collection: what the page keeps, not what garbage collection had not reached yet.
      // Read at the end of the workload they swung 30 MB and 50,000 nodes between runs of one build (#1037).
      await cdp.send("HeapProfiler.collectGarbage");
      const kept = await metrics(cdp);
      const frames = frameStats(probe.frames);
      const bytes = addresses.reduce((sum, _, pane) => sum + workloadBytes(WORKLOAD, pane), 0);

      // Hidden: the same workload with the idle tab selected, then the bench tab selected again.
      const tab = (name: string) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name });
      await tab("idle").click();
      await expect(page.locator(`[data-terminal="${addresses[0]}"]`)).toBeHidden();
      const hiddenBefore = await metrics(cdp);
      writeFileSync(join(dir, "go2"), "");
      await producersDone(dir, panes, 2);
      const hiddenAfter = await metrics(cdp);
      await tab("bench").click();
      const shown = performance.now();
      await allShow(page, addresses, "bench-end-2-");
      const caughtUp = performance.now();

      const run: BenchRun = {
        build: BUILD,
        panes,
        visible: {
          frames: frames.frames,
          frameP50: frames.p50,
          frameP95: frames.p95,
          frameMax: frames.max,
          busyShare: busy(before, after),
          longTasks: probe.longTasks.length,
          longTaskMs: probe.longTasks.reduce((sum, ms) => sum + ms, 0),
          drawnBytesPerSec: bytes / ((drawn - go) / 1000),
          catchUpMs: drawn - produced,
          heapMB: (kept["JSHeapUsedSize"] ?? 0) / 1024 / 1024,
          domNodes: kept["Nodes"] ?? 0,
        },
        hidden: { busyShare: busy(hiddenBefore, hiddenAfter), showCatchUpMs: caughtUp - shown },
      };
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `render-${BUILD}-${panes}-${Date.now()}.json`), `${JSON.stringify(run)}\n`);
      console.log(`render bench ${BUILD} ${panes} panes: ${JSON.stringify(run)}`);
    } finally {
      clearLayout();
      for (const address of started) hcOn("host", ["kill", address]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
