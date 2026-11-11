import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Job = {
  if?: string;
  steps?: Array<{ run?: string; env?: Record<string, string> }>;
  "runs-on"?: string;
  strategy?: { matrix?: { include?: Array<{ runner?: string }> } };
};
type Workflow = { on: { push?: { branches?: string[] }; pull_request?: unknown }; jobs: Record<string, Job> };

const ROOT = join(import.meta.dir, "..", "..");
const ci = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as Workflow;
const builder = JSON.parse(readFileSync(join(ROOT, "apps", "desktop", "electron-builder.json"), "utf8")) as {
  productName: string;
  executableName?: string;
};

const PLATFORM_RUNNER = /^(windows|macos)-/;

// Desktop, Windows and macOS jobs prove a change once it has merged to dev, never on the pull request itself.
function isPlatformJob(id: string, job: Job): boolean {
  const runners = [job["runs-on"] ?? "", ...(job.strategy?.matrix?.include ?? []).map((row) => row.runner ?? "")];
  return id.startsWith("desktop") || runners.some((runner) => PLATFORM_RUNNER.test(runner));
}

const platformJobs = Object.entries(ci.jobs).filter(([id, job]) => isPlatformJob(id, job));

// A push to dev, or a maintainer's dispatch at a pull request's head (#1886); never a pull_request or merge_group run (#613).
test("the desktop, Windows and macOS jobs run only on a push to dev or a dispatch", () => {
  expect(ci.on.push?.branches).toEqual(["dev"]);
  expect(platformJobs.map(([id]) => id)).toEqual(
    expect.arrayContaining(["desktop", "desktop-macos", "windows-private-state"]),
  );
  for (const [id, job] of platformJobs) {
    const condition = job.if ?? "";
    const dispatch = "github.event_name == 'workflow_dispatch'";
    const onlyOnPush =
      condition.includes("github.event_name == 'push'") &&
      condition.includes(dispatch) &&
      !condition.replace(`|| ${dispatch}`, "").includes("||") &&
      !/pull_request|merge_group/.test(condition);
    expect({ id, onlyOnPush }).toEqual({ id, onlyOnPush: true });
  }
});

// electron-builder names the Linux binary executableName, and the macOS bundle and its binary executableName ?? productName.
test("the desktop jobs launch the executable electron-builder.json names", () => {
  const linux = ci.jobs["desktop"]?.steps?.map((step) => step.env?.["DORIFACE_E2E_EXECUTABLE"]).filter(Boolean);
  expect(linux).toEqual(["${{ github.workspace }}/apps/desktop/dist/release/linux-unpacked/" + builder.executableName]);
  const mac = builder.executableName ?? builder.productName;
  const find =
    ci.jobs["desktop-macos"]?.steps?.find((step) => step.run?.includes("DORIFACE_E2E_EXECUTABLE="))?.run ?? "";
  expect(find).toContain(`-name ${mac}.app `);
  expect(find).toContain(`/Contents/MacOS/${mac}" >> "$GITHUB_ENV"`);
});

test("Check, Relay e2e and Web e2e still run on every pull request", () => {
  expect(ci.on).toHaveProperty("pull_request");
  for (const id of ["check", "relay-e2e", "web-e2e"]) {
    expect({ id, found: id in ci.jobs, if: ci.jobs[id]?.if }).toEqual({ id, found: true, if: undefined });
  }
});
