/**
 * Splits the e2e spec files across CI shards by their recorded run time, so the slowest shard, which sets the Web e2e
 * wall time, carries as little as possible. Playwright's own --shard splits by test count, which put 6.3 minutes on one
 * shard and 9.8 on another in the same run (#2687).
 */

export type Timings = Readonly<Record<string, number>>;

interface ReportSuite {
  readonly file: string;
  readonly specs?: readonly { readonly tests: readonly { readonly results: readonly { duration: number }[] }[] }[];
  readonly suites?: readonly ReportSuite[];
}
export interface Report {
  readonly suites: readonly ReportSuite[];
}

function suiteMs(suite: ReportSuite): number {
  const own = (suite.specs ?? []).flatMap((spec) => spec.tests.flatMap((t) => t.results.map((r) => r.duration)));
  return own.reduce((sum, ms) => sum + ms, 0) + (suite.suites ?? []).reduce((sum, inner) => sum + suiteMs(inner), 0);
}

/**
 * Each file the report ran and the summed duration of its tests. `prefix` is the test dir under apps/web (`e2e/`), since
 * the report names files relative to it. A file whose tests were all skipped is still listed, at 0 ms: it ran.
 */
export function reportTimings(report: Report, prefix: string): Record<string, number> {
  const timings: Record<string, number> = {};
  for (const suite of report.suites) {
    const file = `${prefix}${suite.file}`;
    timings[file] = (timings[file] ?? 0) + suiteMs(suite);
  }
  return timings;
}

/**
 * Longest-first onto the least-loaded shard. A file with no recorded time (new, or no record yet) weighs the median of
 * the recorded ones, or 1 when there are none, which splits by count. Ties go to the lower shard and the order is by
 * name, so every shard computes the same plan.
 */
export function planShards(files: readonly string[], timings: Timings, shards: number): string[][] {
  const known = files.flatMap((file) => (timings[file] === undefined ? [] : [timings[file]])).toSorted((a, b) => a - b);
  const fallback = known.length === 0 ? 1 : (known[Math.floor(known.length / 2)] ?? 1);
  const weighted = files
    .map((file) => ({ file, ms: timings[file] ?? fallback }))
    .toSorted((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
  const plan = Array.from({ length: shards }, () => ({ load: 0, files: [] as string[] }));
  for (const { file, ms } of weighted) {
    const lightest = plan.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.files.push(file);
    lightest.load += ms;
  }
  return plan.map((shard) => shard.files.toSorted());
}

/** What is wrong with the shards' ran-files lists against every spec file: a file no shard ran, or one run twice. */
export function coverageGaps(all: readonly string[], ran: readonly (readonly string[])[]): string[] {
  const count = new Map<string, number>();
  for (const files of ran) for (const file of files) count.set(file, (count.get(file) ?? 0) + 1);
  const gaps = all.filter((file) => !count.has(file)).map((file) => `not run: ${file}`);
  for (const [file, n] of count) {
    if (n > 1) gaps.push(`run by ${n} shards: ${file}`);
    if (!all.includes(file)) gaps.push(`not a spec file: ${file}`);
  }
  return gaps.toSorted();
}
