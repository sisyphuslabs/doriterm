import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLONE_LINE, guideEnv, guideScript, guideSteps, RELAY_NOTICE, SYSTEM_PATH } from "./from-zero.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const REV = "0123456789abcdef0123456789abcdef01234567";
const EXECUTABLE = (JSON.parse(read("apps/desktop/electron-builder.json")) as { executableName: string })
  .executableName;

test("only the blocks tagged `sh from-zero` are steps, in order", () => {
  const markdown = [
    "```sh from-zero",
    "echo one",
    "```",
    "```sh",
    "echo not a step",
    "```",
    "```sh from-zero",
    "echo two",
    "```",
  ];
  expect(guideSteps(markdown.join("\n"))).toEqual(["echo one", "echo two"]);
  expect(() => guideSteps("```sh from-zero\necho open")).toThrow("never closed");
});

test("the guide sees a fresh HOME, a stock PATH and none of the runner's secrets", () => {
  const env = guideEnv("/scratch/home", {
    USER: "runner",
    LANG: "C.UTF-8",
    HOME: "/home/runner",
    PATH: "/home/runner/.bun/bin:/usr/local/bin:/usr/bin",
    GITHUB_TOKEN: "ghs_x",
    ACTIONS_RUNTIME_TOKEN: "x",
    DORIFACE_RELAY_READ_TOKEN: "x",
    RELAY_REPO: "owner/relay",
    GH_TOKEN: "x",
    GIT_CONFIG_COUNT: "1",
    HC_BIN: "/opt/hc",
    NODE_OPTIONS: "--require x",
  });
  expect(env).toEqual({
    USER: "runner",
    LANG: "C.UTF-8",
    HOME: "/scratch/home",
    PATH: SYSTEM_PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  expect(SYSTEM_PATH.split(":").filter((dir) => dir.startsWith("/usr/local") || dir.startsWith("/opt"))).toEqual([]);
});

test("the clone moves to the commit under test right after the guide's clone step, and nowhere else", () => {
  const script = guideScript(["echo before", `${CLONE_LINE}\ncd doriterm`, "bun install"], REV);
  const lines = script.split("\n");
  const cd = lines.indexOf("cd doriterm");
  expect(lines.slice(cd + 1, cd + 5)).toEqual([
    'echo "::endgroup::"',
    `echo "from zero: moving the clone to the commit under test, ${REV}"`,
    `git fetch --quiet --depth=1 origin ${REV}`,
    "git checkout --quiet --detach FETCH_HEAD",
  ]);
  expect(lines.indexOf("bun install")).toBeGreaterThan(cd + 4);
  expect(lines[0]).toBe("set -euo pipefail");
  expect(() => guideScript(["echo no clone"], REV)).toThrow("no step clones");
  expect(() => guideScript([CLONE_LINE], REV)).toThrow("cd doriterm");
  expect(() => guideScript([`${CLONE_LINE}\ncd doriterm`], "dev")).toThrow("full commit id");
});

test("CONTRIBUTING.md's from-zero path installs the tools, clones, checks and runs the web e2e, with nothing private", () => {
  const steps = guideSteps(read("CONTRIBUTING.md"));
  const all = steps.join("\n");
  for (const wanted of [
    "https://bun.sh/install",
    "bun-v1.4.4",
    "https://releases.herdr.dev/core/0.1.21/herdr-core-linux-x86_64.tar.gz",
    "sha256sum --check",
    CLONE_LINE,
    "bun install --frozen-lockfile",
    "bun run check",
    "bunx playwright install --with-deps chromium",
    "bun run build",
    "bun run test:e2e",
    "bun run test:e2e:two-runs",
  ]) {
    expect({ wanted, found: all.includes(wanted) }).toEqual({ wanted, found: true });
  }
  for (const privateStep of ["RELAY_REPO", "relay:fetch", "relay:test", "TOKEN", "gh auth", "secrets"]) {
    expect({ privateStep, found: all.includes(privateStep) }).toEqual({ privateStep, found: false });
  }
  expect(() => guideScript(steps, REV)).not.toThrow();
});

type Step = {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = { name?: string; "runs-on"?: string; steps: Step[] };
type Workflow = {
  on: {
    push?: { branches?: string[] };
    pull_request?: { paths?: string[] };
    schedule?: unknown;
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

test("the From zero workflow runs the guide on a clean runner with no secrets", () => {
  const text = read(".github/workflows/from-zero.yml");
  const workflow = Bun.YAML.parse(text) as Workflow;
  expect(text).not.toMatch(/\$\{\{[^}]*secrets\./);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.on.push?.branches).toEqual(["dev"]);
  expect(workflow.on).toHaveProperty("schedule");
  expect(workflow.on).toHaveProperty("workflow_dispatch");
  expect(workflow.on.pull_request?.paths).toEqual([
    "CONTRIBUTING.md",
    ".github/workflows/from-zero.yml",
    "tests/ci/from-zero.ts",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tests/relay/private-relay.ts",
    "apps/web/package.json",
    "apps/web/playwright.config.ts",
    "apps/web/e2e/**",
    "apps/web/scripts/e2e-two-runs.ts",
    "docs/getting-started.md",
    "apps/desktop/e2e/hosted-relay-pair.e2e.ts",
  ]);
  const job = workflow.jobs["contributor"];
  expect(job?.["runs-on"]).toBe("ubuntu-latest");
  const checkout = job?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  const guide = job?.steps.find((step) => step.run?.includes("bun tests/ci/from-zero.ts CONTRIBUTING.md"));
  expect(guide?.env?.["FROM_ZERO_REV"]).toBe("${{ github.sha }}");
  // Only the runner's own bun is installed outside the guide; herdr-core, Node and Chromium come from the guide alone.
  // The upload runs after a failed guide and installs nothing: it keeps the trace the guide left in its own clone.
  expect(job?.steps.filter((step) => step.uses !== undefined).map((step) => step.uses?.split("@")[0])).toEqual([
    "actions/checkout",
    "oven-sh/setup-bun",
    "actions/upload-artifact",
  ]);
  const kept = job?.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(kept?.["if"]).toBe("failure()");
  expect(JSON.stringify(kept?.with?.["path"])).toContain("from-zero-*/work-*/doriterm/apps/web/test-results");
  // Playwright writes its HTML report only when CI is set (apps/web/playwright.config.ts), and the guide's environment
  // does not pass CI, so a report path could never match: the upload keeps the trace in test-results alone (#1353).
  expect(guideEnv("/home", { CI: "true" })["CI"]).toBeUndefined();
  expect(JSON.stringify(kept?.with?.["path"])).not.toContain("playwright-report");
  expect(JSON.stringify(job)).not.toContain("HC_BIN");
});

test("bun run test says in one line why the private relay suites did not run", () => {
  const notice = /console\.log\(\s*"([^"]*)"/.exec(read("tests/relay/private-relay.ts"))?.[1] ?? "";
  expect(notice.startsWith(RELAY_NOTICE)).toBe(true);
  expect(notice).toContain("bun run relay:test");
});

test("every e2e spec gated on the private relay skips with the one shared line, which names the fix", () => {
  const shared = read("apps/web/e2e/private-relay.ts");
  const reason = /export const PRIVATE_RELAY_SKIP =\s*"([^"]*)"/.exec(shared)?.[1] ?? "";
  expect(reason).toContain("bun run relay:fetch");
  expect(reason).not.toContain("\\n");
  const gated: string[] = [];
  for (const app of ["apps/web/e2e", "apps/desktop/e2e"]) {
    for (const file of readdirSync(join(ROOT, app)).filter((name) => name.endsWith(".e2e.ts"))) {
      for (const line of read(`${app}/${file}`).split("\n")) {
        if (!/test\.skip\(/.test(line) || !/RELAY_DIR|relay:fetch|private relay/.test(line)) continue;
        gated.push(file);
        expect({ file, line, shared: line.includes("PRIVATE_RELAY_SKIP") }).toEqual({ file, line, shared: true });
      }
    }
  }
  expect(gated.toSorted()).toEqual([
    "keystroke-latency-relay.e2e.ts",
    "mesh-attach.e2e.ts",
    "mesh-input-hold.e2e.ts",
    "relay-two-devices.e2e.ts",
    "space-rename-relay.e2e.ts",
    "terminal-images-relay.e2e.ts",
    "terminal-links-relay.e2e.ts",
    "terminal-resume-relay.e2e.ts",
  ]);
});

type ReleaseStep = { name?: string; run?: string; env?: Record<string, string>; "working-directory"?: string };
type ReleaseWorkflow = { jobs: Record<string, { needs?: string[]; steps?: ReleaseStep[] }> };

const HOSTED_SPEC = "e2e/hosted-relay-pair.e2e.ts";

test("the release smoke pairs through the hosted relay with the AppImage it is about to publish", () => {
  const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as ReleaseWorkflow;
  const step = release.jobs["smoke-linux"]?.steps?.find((candidate) => candidate.run?.includes(HOSTED_SPEC));
  expect(step?.["working-directory"]).toBe("apps/desktop");
  expect(step?.env).toEqual({ DORIFACE_E2E_EXECUTABLE: "${{ env.APPIMAGE }}", DORIFACE_HOSTED_RELAY_SMOKE: "1" });
  expect(release.jobs["publish"]?.needs).toContain("smoke-linux");
});

test("the From zero workflow checks the user guide through the hosted relay with a packed app", () => {
  const workflow = Bun.YAML.parse(read(".github/workflows/from-zero.yml")) as Workflow & ReleaseWorkflow;
  const steps = workflow.jobs["user-guide"]?.steps ?? [];
  expect(steps.some((step) => step.run?.includes("bun run pack"))).toBe(true);
  const smoke = steps.find((step) => step.run?.includes(HOSTED_SPEC));
  expect(smoke?.env?.["DORIFACE_HOSTED_RELAY_SMOKE"]).toBe("1");
  expect(smoke?.env?.["DORIFACE_E2E_EXECUTABLE"]).toBe(
    "${{ github.workspace }}/apps/desktop/dist/release/linux-unpacked/" + EXECUTABLE,
  );
  expect(workflow.on.pull_request?.paths).toEqual(
    expect.arrayContaining(["docs/getting-started.md", "apps/desktop/e2e/hosted-relay-pair.e2e.ts"]),
  );
});

test("docs/getting-started.md and the hosted-relay spec walk the same controls", () => {
  const guide = read("docs/getting-started.md");
  const spec = read("apps/desktop/e2e/hosted-relay-pair.e2e.ts");
  expect(guide).toContain("apps/desktop/e2e/hosted-relay-pair.e2e.ts");
  for (const control of ["Use this computer", "Pair a device", "They match", "Open terminals", "New tab"]) {
    expect({ control, guide: guide.includes(`**${control}**`), spec: spec.includes(control) }).toEqual({
      control,
      guide: true,
      spec: true,
    });
  }
});
