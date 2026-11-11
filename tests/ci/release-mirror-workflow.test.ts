import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string[] | string;
  environment?: string;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { jobs: Record<string, Job> };

const ROOT = join(import.meta.dir, "..", "..");
const read = (name: string) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");
const release = Bun.YAML.parse(read("release.yml")) as Workflow;
const channel = Bun.YAML.parse(read("release-channel.yml")) as Workflow;
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

test("a published release is mirrored after Publish, in order, and a dispatch mirrors its draft to staging only", () => {
  const { mirror, "mirror-staging": staging } = release.jobs;
  expect(mirror?.if).toBe("github.event_name == 'push'");
  expect(mirror?.needs).toEqual(["version", "publish"]);
  expect(mirror?.environment).toBe("release-mirror");
  const order = [
    "gh release download",
    "release-r2.ts mirror --bucket doriterm-releases --origin https://get.doriterm.com",
    "SHA256SUMS.txt.sig",
    "release-r2.ts probe --origin https://get.doriterm.com",
  ].map((n) => at(mirror, n));
  expect(order.every((index, i) => index >= 0 && (i === 0 || index > (order[i - 1] ?? 0)))).toBe(true);

  expect(staging?.if).toBe("github.event_name == 'workflow_dispatch'");
  expect(staging?.environment).toBe("release-mirror-staging");
  expect(at(staging, "--bucket doriterm-releases-staging --origin https://staging.get.doriterm.com")).toBeGreaterThan(
    0,
  );
  expect(runs(staging).some((run) => /--bucket doriterm-releases\s/.test(run))).toBe(false);
});

test("the R2 key pair and the signing key reach only the mirror jobs and the channel job", () => {
  expect(holders(release)).toEqual(["mirror", "mirror-staging"]);
  expect(holders(channel)).toEqual(["channel"]);
});

test("channel operations run only on dev, and the dispatch inputs reach the shell as environment, never inline", () => {
  const job = channel.jobs["channel"];
  expect(job?.if).toBe("github.ref == 'refs/heads/dev'");
  expect(job?.environment).toBe("${{ inputs.target == 'production' && 'release-mirror' || 'release-mirror-staging' }}");
  for (const run of runs(job)) expect(run).not.toContain("${{");
  expect(at(job, '--op "$OPERATION" --version "$VERSION" --percent "$PERCENT"')).toBeGreaterThan(0);
});
