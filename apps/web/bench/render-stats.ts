/**
 * The render bench's arithmetic (#670), kept pure so a test can catch a wrong measurement or a wrong verdict: frame
 * intervals and their nearest-rank percentiles, the pane grid, the bytes a workload writes, and the release gate's
 * comparison of a candidate's runs with the last release's.
 */

/** A run of the bench at one pane count, as render.bench.ts writes it. */
export interface BenchRun {
  /** Which build of the web client ran: a label such as `candidate` or `v0.1.2`. */
  readonly build: string;
  readonly panes: number;
  /** Every pane in view while each pane's program writes the workload. */
  readonly visible: {
    readonly frames: number;
    readonly frameP50: number;
    readonly frameP95: number;
    readonly frameMax: number;
    /** Main-thread task time over wall time, 0..1, from Chromium's TaskDuration. */
    readonly busyShare: number;
    readonly longTasks: number;
    readonly longTaskMs: number;
    /** Program output bytes over the time from the start until every pane shows its last line. */
    readonly drawnBytesPerSec: number;
    /** From the last program finishing to every pane showing its last line. */
    readonly catchUpMs: number;
    readonly heapMB: number;
    readonly domNodes: number;
  };
  /** The same workload while the panes' tab is not the selected one. */
  readonly hidden: {
    readonly busyShare: number;
    /** From selecting the tab again to every pane showing the hidden phase's last line. */
    readonly showCatchUpMs: number;
  };
}

/** Below this many intervals a nearest-rank p95 is close to the largest one: the window is too short to report. */
export const MIN_FRAMES = 20;

/** Nearest-rank percentile of ascending samples: the sample at rank ceil(p/100 * n), 1-based. */
function percentile(sorted: readonly number[], p: number): number {
  const value = sorted[Math.max(1, Math.ceil((p * sorted.length) / 100)) - 1];
  if (value === undefined) throw new Error("no samples to take a percentile of");
  return value;
}

/** Frame intervals from requestAnimationFrame timestamps (ms): their count, p50, p95 and largest. */
export function frameStats(stamps: readonly number[]): { frames: number; p50: number; p95: number; max: number } {
  const intervals = stamps.slice(1).map((stamp, at) => stamp - (stamps[at] ?? stamp));
  if (intervals.length < MIN_FRAMES) {
    throw new Error(`a frame p95 needs at least ${MIN_FRAMES} frames, got ${intervals.length}`);
  }
  const sorted = intervals.toSorted((a, b) => a - b);
  return {
    frames: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: percentile(sorted, 100),
  };
}

/** Panes per row for `panes` panes in a landscape window: rows of near-equal length, more columns than rows. */
export function gridOf(panes: number): number[] {
  const columns = Math.ceil(Math.sqrt(panes * 1.6));
  const rows = Math.ceil(panes / columns);
  return Array.from({ length: rows }, (_, row) => Math.floor(panes / rows) + (row < panes % rows ? 1 : 0));
}

/** What one pane's program prints per phase: `chunk` and a newline every tick. */
export interface Workload {
  readonly chunk: string;
  readonly ticks: number;
}

/** The bytes pane `pane`'s program writes in phase 1: every tick's chunk and newline, then its end line. */
export function workloadBytes(workload: Workload, pane: number): number {
  const line = Buffer.byteLength(`${workload.chunk}\n`);
  return workload.ticks * line + Buffer.byteLength(`bench-end-1-${pane}\n`);
}

export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) throw new Error("no values to take a median of");
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * How far a candidate's median may move from the baseline's before the gate fails. A metric that grows when worse fails
 * past `ratio` times the baseline AND `floor` above it (so a tiny absolute change on a tiny value is noise); one that
 * shrinks when worse (drawn bytes per second) has a ratio below 1 and fails under `ratio` times the baseline.
 */
export interface Limit {
  readonly ratio: number;
  readonly floor: number;
}

export const GATED = [
  "frameP95",
  "busyShare",
  "catchUpMs",
  "drawnBytesPerSec",
  "heapMB",
  "hiddenBusyShare",
  "showCatchUpMs",
] as const;
export type Gated = (typeof GATED)[number];
export type Thresholds = Readonly<Record<Gated, Limit>>;

const read = (run: BenchRun, metric: Gated): number => {
  if (metric === "hiddenBusyShare") return run.hidden.busyShare;
  if (metric === "showCatchUpMs") return run.hidden.showCatchUpMs;
  return run.visible[metric];
};

export interface Row {
  readonly panes: number;
  readonly metric: Gated;
  readonly baseline: number;
  readonly candidate: number;
  readonly limit: number;
  readonly regressed: boolean;
}

/** Every gated metric at every pane count the candidate ran, as medians over the runs; the regressions apart. */
export function compareRuns(
  baseline: readonly BenchRun[],
  candidate: readonly BenchRun[],
  thresholds: Thresholds,
): { rows: Row[]; regressions: Row[] } {
  const counts = [...new Set(candidate.map((run) => run.panes))].toSorted((a, b) => a - b);
  const rows = counts.flatMap((panes) => {
    const base = baseline.filter((run) => run.panes === panes);
    if (base.length === 0) throw new Error(`no baseline run with ${panes} panes to compare with`);
    const cand = candidate.filter((run) => run.panes === panes);
    return GATED.map((metric): Row => {
      const { ratio, floor } = thresholds[metric];
      const b = median(base.map((run) => read(run, metric)));
      const c = median(cand.map((run) => read(run, metric)));
      const shrinks = ratio < 1;
      const limit = shrinks ? b * ratio : Math.max(b * ratio, b + floor);
      return { panes, metric, baseline: b, candidate: c, limit, regressed: shrinks ? c < limit : c > limit };
    });
  });
  return { rows, regressions: rows.filter((row) => row.regressed) };
}

const fixed = (value: number, digits: number): string => value.toFixed(digits);

/** The bench's table: one row per run. */
export function renderTable(runs: readonly BenchRun[]): string {
  const head =
    "| Build | Panes | Frame p50 ms | Frame p95 ms | Frame max ms | Main busy | Long tasks (ms) | Drawn KiB/s | Catch-up ms | Heap MB | DOM nodes | Hidden busy | Show catch-up ms |";
  const rule = `|${" --- |".repeat(13)}`;
  const rows = runs.map(({ build, panes, visible: v, hidden: h }) =>
    [
      build,
      panes,
      fixed(v.frameP50, 1),
      fixed(v.frameP95, 1),
      fixed(v.frameMax, 1),
      `${fixed(v.busyShare * 100, 1)}%`,
      `${v.longTasks} (${Math.round(v.longTaskMs)})`,
      fixed(v.drawnBytesPerSec / 1024, 1),
      Math.round(v.catchUpMs),
      fixed(v.heapMB, 1),
      v.domNodes,
      `${fixed(h.busyShare * 100, 1)}%`,
      Math.round(h.showCatchUpMs),
    ].join(" | "),
  );
  return [head, rule, ...rows.map((row) => `| ${row} |`)].join("\n");
}

/** The gate's verdict table: every gated metric's medians and limit, regressions marked. */
export function renderVerdict(rows: readonly Row[], baseline: string, candidate: string): string {
  const head = `| Panes | Metric | ${baseline} | ${candidate} | Limit | Verdict |`;
  const lines = rows.map(
    (row) =>
      `| ${row.panes} | ${row.metric} | ${fixed(row.baseline, 3)} | ${fixed(row.candidate, 3)} | ${fixed(row.limit, 3)} | ${row.regressed ? "REGRESSED" : "ok"} |`,
  );
  return [head, "| --- | --- | --- | --- | --- | --- |", ...lines].join("\n");
}
