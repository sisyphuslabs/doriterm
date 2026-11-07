import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");

/** The ref of every `actions/cache`, `actions/cache/restore` and `actions/cache/save` step in a workflow. */
function cacheRefs(text: string): string[] {
  return [...text.matchAll(/uses:\s*actions\/cache(?:\/restore|\/save)?@(\S+)/g)].map(([, ref = ""]) => ref);
}

test("a workflow pins actions/cache's restore and save sub-actions to the same commit as actions/cache itself (#1147)", () => {
  // The sub-actions ship in the same repository and release: one left on an older commit keeps that release's Node
  // runtime (v4.3.0 runs on Node 20) after the main action moved on.
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));
  const split = files.flatMap((name) => {
    const refs = new Set(cacheRefs(readFileSync(join(WORKFLOWS, name), "utf8")));
    return refs.size > 1 ? [`${name}: ${[...refs].join(", ")}`] : [];
  });
  expect(files.length).toBeGreaterThan(0);
  expect(split).toEqual([]);
});
