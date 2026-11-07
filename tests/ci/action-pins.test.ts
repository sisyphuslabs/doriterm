import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");

/** Every `uses:` of a remote action, with the release comment that names what its commit is. */
const remoteUses = (file: string): { file: string; line: string }[] =>
  readFileSync(join(WORKFLOWS, file), "utf8")
    .split("\n")
    .map((line) => line.trim().replace(/^- /, ""))
    .filter((line) => line.startsWith("uses:") && !line.startsWith("uses: ./"))
    .map((line) => ({ file, line }));

// A floating tag can be moved under a workflow; a commit SHA cannot (#791, #894).
test("every workflow names each action by a full commit SHA with its release beside it", () => {
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  const uses = files.flatMap(remoteUses);
  expect(uses.length).toBeGreaterThan(0);
  const floating = uses.filter(({ line }) => !/^uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(line));
  expect(floating).toEqual([]);
});
