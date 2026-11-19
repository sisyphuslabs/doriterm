import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, expect, it } from "bun:test";

import {
  compare,
  countByFile,
  countSuppressions,
  type Counts,
  lint,
  ratchetedFiles,
  SUPPRESSION,
} from "../../.github/scripts/lint-ratchet.ts";

const root = "/repo";

it("counts findings per file and rule, relative to the repo root", () => {
  const counts = countByFile(
    [
      { code: "doriterm-testing(no-module-mock)", filename: "apps/host/src/a.test.ts" },
      { code: "doriterm-testing(no-module-mock)", filename: "/repo/apps/host/src/a.test.ts" },
      { code: "doriterm-testing(no-fixed-sleep)", filename: "apps/host/src/a.test.ts" },
      { code: "doriterm-testing(no-flake-masking)", filename: "tests/ci/b.test.ts" },
    ],
    root,
  );
  expect(counts).toEqual({
    "apps/host/src/a.test.ts": { "doriterm-testing/no-module-mock": 2, "doriterm-testing/no-fixed-sleep": 1 },
    "tests/ci/b.test.ts": { "doriterm-testing/no-flake-masking": 1 },
  });
});

it("refuses a count that goes up, including any finding in a file the baseline does not list", () => {
  const { increases } = compare(
    { "apps/host/src/a.test.ts": { "doriterm-testing/no-module-mock": 2 } },
    {
      "apps/host/src/a.test.ts": { "doriterm-testing/no-module-mock": 3 },
      "apps/host/src/new.test.ts": { "doriterm-testing/no-fixed-sleep": 1 },
    },
  );
  expect(increases).toEqual([
    { file: "apps/host/src/a.test.ts", rule: "doriterm-testing/no-module-mock", before: 2, after: 3 },
    { file: "apps/host/src/new.test.ts", rule: "doriterm-testing/no-fixed-sleep", before: 0, after: 1 },
  ]);
});

it("reports a count that goes down, so the baseline must be lowered in the same change", () => {
  const { increases, decreases } = compare(
    {
      "apps/host/src/a.test.ts": { "doriterm-testing/no-module-mock": 2 },
      "apps/host/src/gone.test.ts": { "doriterm-testing/no-fixed-sleep": 1 },
    },
    { "apps/host/src/a.test.ts": { "doriterm-testing/no-module-mock": 2 } },
  );
  expect(increases).toEqual([]);
  expect(decreases).toEqual([
    { file: "apps/host/src/gone.test.ts", rule: "doriterm-testing/no-fixed-sleep", before: 1, after: 0 },
  ]);
});

it("accepts counts that match the baseline exactly", () => {
  const counts = { "apps/host/src/a.test.ts": { "doriterm-testing/no-module-mock": 2 } };
  expect(compare(counts, counts)).toEqual({ increases: [], decreases: [] });
});

it("counts every disable comment that could hide one of the ratcheted rules, in both linters' forms", () => {
  // Built at runtime so this file holds no directive of its own for the gate to count.
  const line = "/".repeat(2);
  const block = ["/", "*"].join("");
  const source = [
    `${line} oxlint-disable-next-line doriterm-testing/no-fixed-sleep`,
    `${line} eslint-disable-next-line doriterm-testing/no-flake-masking -- legacy`,
    `${block} eslint-disable */`,
    `const a = 1; ${line} oxlint-disable-line`,
    `${line} oxlint-disable-next-line doriterm-testing/no-module-mock, eslint/no-console`,
    `${line} oxlint-disable-next-line eslint/no-console -- unrelated rule, not counted`,
    `const text = "oxlint-disable-next-line doriterm-testing/no-module-mock";`,
    `${block}\n  eslint-disable-next-line doriterm-testing/no-fixed-sleep\n*/`,
  ].join("\n");
  expect(countSuppressions("probe.ts", source)).toBe(6);
  expect(countSuppressions("probe.ts", "const x = 1;\n")).toBe(0);
});

it("refuses a new disable comment like any other rise", () => {
  const { increases } = compare({}, { "tests/ci/probe.ts": { [SUPPRESSION]: 1 } });
  expect(increases).toEqual([{ file: "tests/ci/probe.ts", rule: SUPPRESSION, before: 0, after: 1 }]);
});

it("skips generated sources by path, so only hand-written files are ratcheted", () => {
  expect(
    ratchetedFiles([
      "packages/protocol/src/__generated__/hc-api.ts",
      "packages/protocol/src/generated-names.ts",
      "apps/landing/main.js",
      "README.md",
    ]),
  ).toEqual(["packages/protocol/src/generated-names.ts", "apps/landing/main.js"]);
});

// The ratchet's own lint run, on a scratch repo whose .eslintignore lists a violating test: oxlint
// honours that file unless told not to, which would drop the test's counts without any rise.
let ignoredRepoCounts: Counts = {};
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "doriterm-lint-ratchet-ignore-"));
  try {
    for (const entry of ["node_modules", ".github"])
      symlinkSync(join(import.meta.dir, "../..", entry), join(dir, entry));
    const source = 'import { mock } from "bun:test";\nmock.module("./dep", () => ({}));\n';
    for (const file of ["hidden.test.ts", "visible.test.ts"]) writeFileSync(join(dir, file), source);
    writeFileSync(join(dir, ".eslintignore"), "hidden.test.ts\n");
    for (const args of [
      ["init", "-q"],
      ["add", "--", "."],
    ])
      expect(spawnSync("git", args, { cwd: dir }).status).toBe(0);
    ignoredRepoCounts = lint(dir).counts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it("still counts a file that an ignore file lists", () => {
  expect(ignoredRepoCounts).toEqual({
    "hidden.test.ts": { "doriterm-testing/no-module-mock": 1 },
    "visible.test.ts": { "doriterm-testing/no-module-mock": 1 },
  });
});
