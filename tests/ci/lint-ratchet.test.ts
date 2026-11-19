import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeAll, expect, it } from "bun:test";

import {
  compare,
  countByFile,
  countSuppressions,
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

// The ratchet's own lint run in a scratch git repo that reuses this repo's oxlint and plugin, with a
// violating test beside a copy of the ratchet config (a config's ignorePatterns resolve in its own
// directory). Listed in .eslintignore, the test is still counted; hidden by the config's
// ignorePatterns, which --no-ignore does not reach, it is reported as skipped instead of as zero.
let listedInEslintignore: ReturnType<typeof lint> | undefined;
let hiddenByIgnorePatterns: ReturnType<typeof lint> | undefined;
beforeAll(() => {
  const repo = join(import.meta.dir, "../..");
  const scratch = mkdtempSync(join(tmpdir(), "doriterm-lint-ratchet-ignore-"));
  try {
    const config = join(scratch, ".github/scripts/lint-ratchet.oxlintrc.json");
    const shipped = JSON.parse(readFileSync(join(repo, ".github/scripts/lint-ratchet.oxlintrc.json"), "utf8"));
    mkdirSync(dirname(config), { recursive: true });
    for (const entry of ["node_modules", ".github/scripts/oxlint"])
      symlinkSync(join(repo, entry), join(scratch, entry));
    writeFileSync(config, JSON.stringify(shipped));
    writeFileSync(
      join(scratch, ".github/scripts/hidden.test.ts"),
      'import { mock } from "bun:test";\nmock.module("./dep", () => ({}));\n',
    );
    writeFileSync(join(scratch, "clean.ts"), "export const clean = 1;\n");
    writeFileSync(join(scratch, ".eslintignore"), ".github/scripts/hidden.test.ts\n");
    for (const args of [
      ["init", "-q"],
      ["add", "--", "."],
    ])
      expect(spawnSync("git", args, { cwd: scratch }).status).toBe(0);
    listedInEslintignore = lint(scratch);
    writeFileSync(config, JSON.stringify({ ...shipped, ignorePatterns: ["hidden.test.ts"] }));
    hiddenByIgnorePatterns = lint(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

it("still counts a violating file that .eslintignore lists", () => {
  expect(listedInEslintignore).toEqual({
    counts: { ".github/scripts/hidden.test.ts": { "doriterm-testing/no-module-mock": 1 } },
    unparsed: [],
    skipped: 0,
  });
});

it("reports a file hidden by the ratchet config's ignorePatterns as skipped, not as zero findings", () => {
  expect(hiddenByIgnorePatterns).toEqual({ counts: {}, unparsed: [], skipped: 1 });
});
