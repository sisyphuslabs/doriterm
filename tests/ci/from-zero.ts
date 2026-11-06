/**
 * Runs CONTRIBUTING.md's "From zero" path the way a new contributor would, on a machine that has none of this
 * repository's tools (#672): every fenced block tagged `sh from-zero` runs in order, in one bash, in an empty directory,
 * with a HOME of its own and an environment that carries no secret, no git credential and no token.
 *
 *   bun tests/ci/from-zero.ts [CONTRIBUTING.md]
 *
 * The guide clones the public repository; to test the commit under test, the run then moves that clone to
 * `FROM_ZERO_REV` with an anonymous fetch from the same public URL. Nothing else is added to what the guide says.
 * The run fails when a step fails, when bun or hc were already there before the guide installed them (so the run would
 * not prove the guide installs them), and when `bun run check` did not say, in its one line, why the private relay suites
 * did not run.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The info string that marks a block of the guide as a step this run executes. */
export const STEP_TAG = "sh from-zero";

/** The guide's clone line; the run moves the clone to the commit under test right after the block that holds it. */
export const CLONE_LINE = "git clone https://github.com/sisyphuslabs/doriterm.git";

/** What `bun run test` prints, on one line, when the private relay suites in tests/relay did not run. */
export const RELAY_NOTICE = "tests/relay skipped: ";

/**
 * The PATH of a stock Linux install. /usr/local and /opt are left out: on a CI image they hold preinstalled toolchains
 * (Node among them) that a new contributor's machine does not have.
 */
export const SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

const PASSED = ["USER", "LANG", "TERM"] as const;

/** The fenced blocks tagged `sh from-zero`, in order, without their fences. */
export function guideSteps(markdown: string): string[] {
  const steps: string[] = [];
  let open: string[] | undefined;
  for (const line of markdown.split("\n")) {
    if (open === undefined) {
      if (line.trim() === "```" + STEP_TAG) open = [];
    } else if (line.trim() === "```") {
      steps.push(open.join("\n"));
      open = undefined;
    } else {
      open.push(line);
    }
  }
  if (open !== undefined) throw new Error("a `sh from-zero` block is never closed");
  return steps;
}

/** The environment the guide runs in: a fresh HOME, a stock PATH, no git credential and nothing else of the runner's. */
export function guideEnv(home: string, runner: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const value = runner[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    PATH: SYSTEM_PATH,
    // No system git config (a CI image may carry credential helpers there) and no prompt for a password: a step that
    // needs a credential fails instead of waiting.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

const firstLine = (step: string): string => step.split("\n").find((line) => line.trim() !== "") ?? "";

/** One bash script: every step in order, the move to `rev` right after the clone step, each step in its own log group. */
export function guideScript(steps: readonly string[], rev: string): string {
  if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error(`FROM_ZERO_REV must be a full commit id, got '${rev}'`);
  const clone = steps.findIndex((step) => step.includes(CLONE_LINE));
  if (clone === -1) throw new Error(`no step clones the repository with '${CLONE_LINE}'`);
  const cloneStep = steps[clone]?.trimEnd() ?? "";
  if (!cloneStep.endsWith("cd doriterm")) throw new Error("the clone step must end in the clone: `cd doriterm`");
  const lines = ["set -euo pipefail"];
  steps.forEach((step, index) => {
    lines.push(
      `echo "::group::from zero, step ${index + 1} of ${steps.length}: ${firstLine(step).replace(/["$`\\]/g, "\\$&")}"`,
    );
    lines.push(step);
    lines.push('echo "::endgroup::"');
    if (index === clone) {
      lines.push(`echo "from zero: moving the clone to the commit under test, ${rev}"`);
      lines.push(`git fetch --quiet --depth=1 origin ${rev}`);
      lines.push("git checkout --quiet --detach FETCH_HEAD");
    }
  });
  return `${lines.join("\n")}\n`;
}

async function collect(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    sink.write(chunk);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function run(argv: readonly string[], cwd: string, env: Record<string, string>): Promise<[number, string]> {
  const proc = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([collect(proc.stdout, process.stdout), collect(proc.stderr, process.stderr)]);
  return [await proc.exited, out + err];
}

async function main(guide: string): Promise<number> {
  const rev = process.env["FROM_ZERO_REV"] ?? "";
  const steps = guideSteps(readFileSync(guide, "utf8"));
  const script = guideScript(steps, rev);
  const base = mkdtempSync(join(process.env["RUNNER_TEMP"] ?? tmpdir(), "from-zero-"));
  const home = mkdtempSync(join(base, "home-"));
  const work = mkdtempSync(join(base, "work-"));
  const scriptPath = join(base, "guide.sh");
  writeFileSync(scriptPath, script);
  const env = guideEnv(home, process.env);
  console.log(`from zero: ${steps.length} steps from ${guide}, in ${work}, HOME=${home}, PATH=${SYSTEM_PATH}`);

  const [already] = await run(["bash", "-c", "command -v bun || command -v hc"], work, env);
  if (already === 0) {
    console.error(
      "::error::bun or hc is already on the guide's PATH, so this run cannot show the guide installs them.",
    );
    return 1;
  }
  const [code, output] = await run(["bash", scriptPath], work, env);
  if (code !== 0) {
    console.error(`::error::a step of the from-zero guide failed (exit ${code}); the log group above names it.`);
    return code;
  }
  const notice = output.split("\n").find((line) => line.startsWith(RELAY_NOTICE));
  if (notice === undefined) {
    console.error(
      `::error::bun run check never printed '${RELAY_NOTICE}…', the line that says why tests/relay did not run.`,
    );
    return 1;
  }
  console.log(`from zero: every step passed with nothing private; the relay suites said: ${notice}`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv[2] ?? "CONTRIBUTING.md");
