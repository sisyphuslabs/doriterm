import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type Value } from "./gh-expression.ts";

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
  // What it comes to for each caller: a hand-run (no published input), release.yml's production call and its draft call.
  const requires = (published: Value) =>
    evaluate(mirror?.env?.["REQUIRE_PUBLISHED"] ?? "", { contexts: { inputs: { published } } });
  expect([requires(null), requires(true), requires(false)]).toEqual([true, true, false]);
  // The expression it replaced let every hand-run through (#2126 review): null != false is false in GitHub's equality.
  expect(evaluate("${{ inputs.published != false }}", { contexts: { inputs: { published: null } } })).toBe(false);
});

test("a release is never public unsigned: a sign job signs the draft, and Publish waits for it and checks it (#2297)", () => {
  const { publish, sign, "mirror-staging": staging } = release.jobs;
  // Supersedes #2300's first shape, which signed in the staging mirror: a tag after a dispatch of the same version, or a
  // backport, made that mirror fail and held Publish for ever.
  expect(publish?.needs).toContain("sign");
  expect(publish?.needs).not.toContain("mirror-staging");
  const steps = (publish?.steps ?? []).map((step) => step.name ?? "");
  const guard = steps.indexOf("The draft carries its signature");
  expect([guard >= 0, guard < steps.indexOf("Publish the draft")]).toEqual([true, true]);
  expect(publish?.steps?.[guard]?.run).toContain("grep -qx SHA256SUMS.txt.sig");
  expect([sign?.if, sign?.environment]).toEqual(["github.event_name == 'push'", "release-mirror-staging"]);
  expect(runs(sign).join("\n")).toContain("release-r2.ts sign --dir");
  expect(staging?.if).toBe("github.event_name == 'workflow_dispatch'");
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

test("the R2 key pair and the signing key reach only the mirror job, the channel job and release.yml's sign job", () => {
  // The sign job holds the signing key alone, in its step, and no R2 key (#2297).
  expect(holders(release)).toEqual(["sign"]);
  const sign = release.jobs["sign"];
  const names = [sign, ...(sign?.steps ?? [])].flatMap((scope) => Object.keys(scope?.env ?? {}));
  expect(names.filter((name) => /^(R2_|RELEASE_SIGNING_KEY)/.test(name))).toEqual(["RELEASE_SIGNING_KEY"]);
  expect(Object.keys(sign?.env ?? {})).not.toContain("RELEASE_SIGNING_KEY");
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

test("the mirror takes only the tags a host takes: no number with a leading zero (#2297)", () => {
  const check = mirrorFlow.jobs["mirror"]?.steps?.find((step) => step.name === "The tag and the target")?.run ?? "";
  const pattern = /\[\[ "\$TAG" =~ (\S+) \]\]/.exec(check)?.[1];
  if (pattern === undefined) throw new Error("the tag check has no =~ pattern");
  const takes = (tag: string): boolean =>
    Bun.spawnSync(["bash", "-c", `[[ "$1" =~ ${pattern} ]]`, "_", tag]).exitCode === 0;
  for (const tag of ["v0.1.18", "v0.1.18-beta.9", "v0.1.18-beta.10", "v0.1.18-rc.0", "v10.0.0", "v0.1.18-0a.1"])
    expect([tag, takes(tag)]).toEqual([tag, true]);
  for (const tag of ["v0.1.18-beta.09", "v01.1.18", "v0.01.18", "v0.1.018", "v0.1.18-00", "0.1.18", "v0.1"])
    expect([tag, takes(tag)]).toEqual([tag, false]);
});
