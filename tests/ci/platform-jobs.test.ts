import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executableName } from "./support/electron-builder.ts";

type Job = {
  if?: string;
  needs?: string | string[];
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

test("the desktop, Windows and macOS jobs run only on a push to dev", () => {
  expect(ci.on.push?.branches).toEqual(["dev"]);
  expect(platformJobs.map(([id]) => id)).toEqual(
    expect.arrayContaining(["desktop", "desktop-macos", "windows-private-state"]),
  );
  for (const [id, job] of platformJobs) {
    const condition = job.if ?? "";
    const onlyOnPush =
      condition.includes("github.event_name == 'push'") &&
      !condition.includes("||") &&
      !/pull_request|merge_group/.test(condition);
    expect({ id, onlyOnPush }).toEqual({ id, onlyOnPush: true });
  }
});

// electron-builder names the Linux binary executableName, and the macOS bundle and its binary executableName ?? productName.
test("the desktop jobs launch the executable electron-builder.json names", () => {
  const linux = ci.jobs["desktop"]?.steps?.map((step) => step.env?.["DORIFACE_E2E_EXECUTABLE"]).filter(Boolean);
  expect(linux).toEqual(["${{ github.workspace }}/apps/desktop/dist/release/linux-unpacked/" + executableName()]);
  const mac = builder.executableName ?? builder.productName;
  const find =
    ci.jobs["desktop-macos"]?.steps?.find((step) => step.run?.includes("DORIFACE_E2E_EXECUTABLE="))?.run ?? "";
  expect(find).toContain(`-name ${mac}.app `);
  expect(find).toContain(`/Contents/MacOS/${mac}" >> "$GITHUB_ENV"`);
});

test("Check, Relay e2e and Web e2e still run on every pull request", () => {
  expect(ci.on).toHaveProperty("pull_request");
  expect({ id: "check", if: ci.jobs["check"]?.if }).toEqual({ id: "check", if: undefined });
  // Relay e2e and Web e2e report the sum of their parts, so they run always(): a reporter skipped after a failed part
  // would be reported as a success.
  const reporters = { "relay-e2e": "relay-e2e-part", "web-e2e": "web-e2e-shard" };
  for (const [id, part] of Object.entries(reporters)) {
    const job = ci.jobs[id];
    expect({ id, if: job?.if, needs: job?.needs }).toEqual({ id, if: "always()", needs: part });
    expect({ part, onlyOnPush: /event_name == 'push'/.test(ci.jobs[part]?.if ?? "") }).toEqual({
      part,
      onlyOnPush: false,
    });
  }
});
