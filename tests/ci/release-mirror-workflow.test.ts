import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string[] | string;
  environment?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const ROOT = join(import.meta.dir, "..", "..");
const read = (name: string) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");
const release = Bun.YAML.parse(read("release.yml")) as Workflow;
const mirrorFlow = Bun.YAML.parse(read("release-mirror.yml")) as Workflow;
const channel = Bun.YAML.parse(read("release-channel.yml")) as Workflow;
const mirror = mirrorFlow.jobs["mirror"];
const runs = (job: Job | undefined) => (job?.steps ?? []).map((step) => step.run ?? "");
const holders = (workflow: Workflow) =>
  Object.entries(workflow.jobs)
    .filter(([, job]) =>
      [job, ...(job.steps ?? [])].some((scope) =>
        Object.keys(scope.env ?? {}).some((name) => /^(R2_|RELEASE_SIGNING_KEY)/.test(name)),
      ),
    )
    .map(([name]) => name);
const at = (job: Job | undefined, needle: string) => runs(job).findIndex((run) => run.includes(needle));

test("release.yml mirrors a published release to production after Publish, and a manual draft to staging, through the one mirror job", () => {
  const { mirror: production, "mirror-staging": staging } = release.jobs;
  expect(production?.if).toBe("github.event_name == 'push'");
  expect(production?.needs).toEqual(["version", "publish"]);
  expect(production?.uses).toBe("./.github/workflows/release-mirror.yml");
  expect(production?.with).toEqual({ tag: "${{ needs.version.outputs.tag }}", target: "production" });
  expect(staging?.if).toBe("github.event_name == 'workflow_dispatch'");
  expect(staging?.uses).toBe("./.github/workflows/release-mirror.yml");
  expect(staging?.with).toEqual({ tag: "${{ needs.version.outputs.tag }}", target: "staging", published: false });
  for (const job of [production, staging]) {
    expect(job?.secrets).toBe("inherit");
    expect(job?.permissions).toEqual({ contents: "write" });
  }
});

test("the mirror job checks the tag, then downloads, mirrors, signs and probes in that order", () => {
  const order = [
    "isDraft --jq .isDraft",
    "gh release download",
    "release-r2.ts mirror",
    "SHA256SUMS.txt.sig",
    "release-r2.ts probe",
  ].map((needle) => at(mirror, needle));
  expect(order.every((index, i) => index >= 0 && (i === 0 || index > (order[i - 1] ?? 0)))).toBe(true);
  expect(runs(mirror)[order[0] ?? 0]).toContain('if [ "$REQUIRE_PUBLISHED" = true ] && [ "$draft" != false ]');
  expect(mirror?.env?.["REQUIRE_PUBLISHED"]).toBe("${{ inputs.published != false }}");
  expect(mirror?.steps?.find((step) => step.name === "Attach the checksums signature")?.if).toBe(
    "inputs.target == 'production'",
  );
});

test("run by hand it mirrors a published release from dev only, in the environment of its target", () => {
  expect(Object.keys(mirrorFlow.on).toSorted()).toEqual(["workflow_call", "workflow_dispatch"]);
  expect(mirror?.if).toBe("github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/dev'");
  expect(mirror?.environment).toBe(
    "${{ inputs.target == 'production' && 'release-mirror' || 'release-mirror-staging' }}",
  );
  expect(mirror?.env?.["BUCKET"]).toBe(
    "${{ inputs.target == 'production' && 'doriterm-releases' || 'doriterm-releases-staging' }}",
  );
  for (const run of runs(mirror)) expect(run).not.toMatch(/\$\{\{\s*inputs\./);
});

test("the R2 key pair and the signing key reach only the mirror job and the channel job", () => {
  expect(holders(release)).toEqual([]);
  expect(holders(mirrorFlow)).toEqual(["mirror"]);
  expect(holders(channel)).toEqual(["channel"]);
});

test("channel operations run only on dev, and the dispatch inputs reach the shell as environment, never inline", () => {
  const job = channel.jobs["channel"];
  expect(job?.if).toBe("github.ref == 'refs/heads/dev'");
  expect(job?.environment).toBe("${{ inputs.target == 'production' && 'release-mirror' || 'release-mirror-staging' }}");
  for (const run of runs(job)) expect(run).not.toContain("${{");
  expect(at(job, '--op "$OPERATION" --version "$VERSION" --percent "$PERCENT"')).toBeGreaterThan(0);
});
