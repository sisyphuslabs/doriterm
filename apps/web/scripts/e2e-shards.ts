/**
 * The Web e2e shard plan for CI, from apps/web:
 *
 *   bun scripts/e2e-shards.ts pick <k> <n> [timings.json]    the Playwright file arguments for shard k of n
 *   bun scripts/e2e-shards.ts record <report.json>           the per-file times of one shard's JSON report
 *   bun scripts/e2e-shards.ts cover <out.json> <shard.json>…  fails unless the shards ran every spec file exactly once,
 *                                                            and writes their merged times (the next run's record)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { coverageGaps, planShards, type Report, reportTimings, type Timings } from "./e2e-shard-plan.ts";

const TEST_DIR = "e2e/";

const specFiles = (): string[] => [...new Bun.Glob(`${TEST_DIR}**/*.e2e.ts`).scanSync(".")].toSorted();

const readTimings = (path: string): Timings =>
  (JSON.parse(readFileSync(path, "utf8")) as { files: Record<string, number> }).files;

/** A path as Playwright's file filter, which is a regular expression over the absolute path: exact, never a prefix. */
const fileFilter = (file: string): string => `/${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

function main(argv: readonly string[]): number {
  const [command, ...args] = argv;
  if (command === "pick") {
    const [k = "", n = "", timings] = args;
    const shards = Number(n);
    const index = Number(k) - 1;
    if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(index) || index < 0 || index >= shards) {
      throw new Error(`pick needs <k> <n> with 1 <= k <= n, got '${k}' '${n}'`);
    }
    const record = timings !== undefined && existsSync(timings) ? readTimings(timings) : {};
    console.error(`e2e shards: ${Object.keys(record).length} recorded file times`);
    console.log((planShards(specFiles(), record, shards)[index] ?? []).map(fileFilter).join("\n"));
    return 0;
  }
  if (command === "record") {
    const report = JSON.parse(readFileSync(args[0] ?? "", "utf8")) as Report;
    console.log(JSON.stringify({ version: 1, files: reportTimings(report, TEST_DIR) }, null, 2));
    return 0;
  }
  if (command === "cover") {
    const [out = "", ...shards] = args;
    const ran = shards.map(readTimings);
    const gaps = coverageGaps(
      specFiles(),
      ran.map((files) => Object.keys(files)),
    );
    const total = ran.reduce((sum, files) => sum + Object.keys(files).length, 0);
    console.log(`e2e shards: ${shards.length} shards ran ${total} spec files; ${specFiles().length} exist`);
    for (const gap of gaps) console.error(`::error::${gap}`);
    writeFileSync(out, JSON.stringify({ version: 1, files: Object.assign({}, ...ran) }, null, 2));
    return gaps.length === 0 ? 0 : 1;
  }
  throw new Error(
    "usage: e2e-shards.ts pick <k> <n> [timings.json] | record <report.json> | cover <out> <shard.json>…",
  );
}

if (import.meta.main) process.exitCode = main(Bun.argv.slice(2));
