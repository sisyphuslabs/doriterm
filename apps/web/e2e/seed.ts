// Demo terminals for screenshot captures: a plain shell and three agents reporting OSC 7501 status, each in the space
// its `space` label names. A terminal's directory alone no longer names its space: adoption (#404) reads the label,
// then the space whose folder holds the directory, then Home, so the label is what puts the demo in doriface and website.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const agent = (state: string, msg: string, lines: readonly string[]): string[] => [
  "sh",
  "-c",
  `printf '\\033]7501;state=${state}:msg=${btoa(msg)}\\033\\\\'; printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")}; exec sleep 3600`,
];

const SEEDS: readonly { readonly name: string; readonly space: string; readonly argv: readonly string[] }[] = [
  { name: "shell", space: "doriface", argv: ["env", "PS1=$ ", "bash", "--norc", "--noprofile", "-i"] },
  {
    name: "review",
    space: "doriface",
    argv: agent("working", "Reviewing the relay PR", ["Reading apps/relay/src/session.ts", "Checking close codes"]),
  },
  {
    name: "deploy",
    space: "website",
    argv: agent("blocked", "Approve the production deploy?", ["Build passed", "Waiting for approval"]),
  },
  { name: "tests", space: "website", argv: agent("done", "All 128 tests passed", ["128 pass", "0 fail"]) },
];

/** One at a time, in SEEDS order, so every core lists the same first terminal and the captures do not change. */
export async function seed(hc: string, env: Record<string, string | undefined>, root: string): Promise<void> {
  for (const { name, space, argv } of SEEDS) {
    const cwd = join(root, space);
    mkdirSync(cwd, { recursive: true });
    const run = Bun.spawn([hc, "run", "--bg", "--name", name, "--label", `space=${space}`, "--", ...argv], {
      env,
      cwd,
      stdout: "ignore",
    });
    // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: the start order is the terminal order
    if ((await run.exited) !== 0) throw new Error(`hc run ${name} failed`);
  }
}
