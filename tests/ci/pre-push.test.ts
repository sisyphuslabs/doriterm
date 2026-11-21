import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FAST_CHECK, pushedBranchCommits, pushRefusal } from "../../.github/scripts/pre-push.ts";

const ROOT = join(import.meta.dir, "..", "..");
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ZERO = "0".repeat(40);

type Ci = { jobs: Record<string, { steps?: { run?: string }[] }> };
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

test("the hook and the Check job run one script, and `bun run check` is that script plus the tests", () => {
  const ci = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as Ci;
  const runs = (ci.jobs["check"]?.steps ?? []).map((step) => step.run);
  expect(runs).toContain(FAST_CHECK);
  for (const covered of ["bun run typecheck", "bun run lint", "bun run fmt:check"]) {
    expect({ covered, alsoRunAlone: runs.includes(covered) }).toEqual({ covered, alsoRunAlone: false });
  }
  expect(pkg.scripts["check:fast"]).toBe(
    "bun run typecheck && bun run lint && bun run fmt:check && bun run gen:api:check",
  );
  expect(pkg.scripts["check"]).toBe(`${FAST_CHECK} && bun run test`);
});

test("bun install activates the hook through husky", () => {
  expect(pkg.scripts["prepare"]).toBe("husky");
  expect(pkg.devDependencies["husky"]).toBeDefined();
  expect(readFileSync(join(ROOT, ".husky", "pre-push"), "utf8")).toContain('"$bun_bin" .github/scripts/pre-push.ts');
});

test("a push judges the commits it sends to branches; tags and deletions are not judged", () => {
  const refs = [
    `refs/heads/x ${HEAD} refs/heads/x ${OTHER}`,
    `refs/tags/v1 ${OTHER} refs/tags/v1 ${ZERO}`,
    `(delete) ${ZERO} refs/heads/gone ${OTHER}`,
  ].join("\n");
  expect(pushedBranchCommits(refs)).toEqual([HEAD]);
  expect(pushedBranchCommits("")).toEqual([]);
});

test("HEAD from a clean tree is judged; another commit or a dirty tree is refused", () => {
  expect(pushRefusal([HEAD], HEAD, false)).toBeUndefined();
  expect(pushRefusal([OTHER], HEAD, false)).toContain("not HEAD");
  expect(pushRefusal([HEAD], HEAD, true)).toContain("uncommitted");
});
