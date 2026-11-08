#!/usr/bin/env bun
/**
 * `bun run bench:render` (#670): runs the render bench (render.bench.ts) and prints its table.
 *
 *   bun bench/run.ts [--panes 1,15,50] [--rounds N] [--out DIR] [--build LABEL=WEB_DIST ...]
 *                    [--compare BASELINE_LABEL --thresholds FILE]
 *
 * With no --build the web app is built from this checkout and labelled `candidate`. Each --build serves a prebuilt web
 * app; every round runs each build once, in an order that alternates round by round so drift on the runner falls on both.
 * --compare checks every other build against the named one with the thresholds file and exits 1 on a regression.
 * The runs, the table and the verdict are written to the out dir (render-bench.json, render-bench.md).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type BenchRun, type Thresholds, compareRuns, renderTable, renderVerdict } from "./render-stats.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    panes: { type: "string", default: "1,15,50" },
    rounds: { type: "string", default: "1" },
    out: { type: "string", default: "bench-out" },
    build: { type: "string", multiple: true, default: [] },
    compare: { type: "string" },
    thresholds: { type: "string", default: join(import.meta.dir, "thresholds.json") },
  },
});

const WEB = join(import.meta.dir, "..");
const out = resolve(values.out);
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1)
  throw new Error(`--rounds must be a positive integer, got ${values.rounds}`);
const builds = values.build.map((spec) => {
  const at = spec.indexOf("=");
  if (at <= 0) throw new Error(`--build takes LABEL=WEB_DIST, got ${spec}`);
  return { label: spec.slice(0, at), dist: resolve(spec.slice(at + 1)) };
});
if (builds.length === 0) builds.push({ label: "candidate", dist: "" });
const runsDir = join(out, "runs");
// The table and the medians are this invocation's runs only: an earlier bench into the same --out left its own (#844).
rmSync(runsDir, { recursive: true, force: true });
mkdirSync(runsDir, { recursive: true });

for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 === 0 ? builds : builds.toReversed();
  for (const build of order) {
    console.log(`render bench: round ${round + 1}/${rounds}, ${build.label}`);
    const env: Record<string, string | undefined> = {
      ...process.env,
      BENCH_BUILD: build.label,
      BENCH_OUT: runsDir,
      BENCH_PANES: values.panes,
      BENCH_PLAYWRIGHT_DIR: join(out, "playwright", `${round}-${build.label}`),
    };
    if (build.dist === "") delete env["BENCH_WEB_DIST"];
    else env["BENCH_WEB_DIST"] = build.dist;
    // oxlint-disable-next-line no-await-in-loop -- runs are sequential: two at once would share the machine
    const code = await Bun.spawn(["bunx", "playwright", "test", "-c", "bench/playwright.config.ts"], {
      cwd: WEB,
      env,
      stdio: ["inherit", "inherit", "inherit"],
    }).exited;
    if (code !== 0) throw new Error(`the render bench failed for ${build.label} in round ${round + 1} (exit ${code})`);
  }
}

const runs = readdirSync(runsDir)
  .filter((name) => name.endsWith(".json"))
  .toSorted()
  .map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")) as BenchRun);
const sections = [`## Render bench\n\n${renderTable(runs)}`];
let regressed = false;
if (values.compare !== undefined) {
  const thresholds = JSON.parse(readFileSync(values.thresholds, "utf8")) as { limits: Thresholds };
  const baseline = runs.filter((run) => run.build === values.compare);
  for (const label of new Set(runs.map((run) => run.build).filter((build) => build !== values.compare))) {
    const verdict = compareRuns(
      baseline,
      runs.filter((run) => run.build === label),
      thresholds.limits,
    );
    regressed ||= verdict.regressions.length > 0;
    sections.push(
      `## ${label} against ${values.compare} (medians of ${rounds} rounds)\n\n${renderVerdict(verdict.rows, values.compare, label)}`,
    );
  }
}
const report = sections.join("\n\n");
writeFileSync(join(out, "render-bench.json"), `${JSON.stringify(runs, null, 2)}\n`);
writeFileSync(join(out, "render-bench.md"), `${report}\n`);
console.log(report);
if (regressed) {
  console.error("render bench: a gated metric regressed past its threshold (bench/thresholds.json)");
  process.exit(1);
}
