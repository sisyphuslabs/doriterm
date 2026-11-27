import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = { if?: string; environment?: string; env?: Record<string, string>; "runs-on"?: string; steps?: Step[] };
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "core-mirror.yml"), "utf8"),
) as Workflow;
const jobs = Object.values(workflow.jobs);
const mirror = workflow.jobs["mirror"];
const steps = mirror?.steps ?? [];
const SECRET = /^(R2_|RELEASE_SIGNING_KEY|CLOUDFLARE_)/;
const at = (needle: string) => steps.findIndex((step) => (step.run ?? "").includes(needle));

test("only a maintainer's dispatch from dev runs it, with read-only repository access", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(mirror?.if).toBe("github.ref == 'refs/heads/dev'");
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(mirror?.environment).toBe(
    "${{ inputs.target == 'production' && 'release-mirror' || 'release-mirror-staging' }}",
  );
});

test("the bucket and signing secrets reach only the one mirror step, never the job or a download step", () => {
  expect(jobs.every((job) => Object.keys(job.env ?? {}).every((name) => !SECRET.test(name)))).toBe(true);
  const holders = steps.filter((step) => Object.keys(step.env ?? {}).some((name) => SECRET.test(name)));
  expect(holders.map((step) => step.name)).toEqual(["Mirror into the bucket, sign, and move core/latest"]);
  expect(holders[0]?.run).toContain("release-r2.ts core-mirror");
});

test("herdr's archives are fetched, then the macOS ones checked against herdr's codesign requirement, before anything is signed", () => {
  const fetched = at("release-r2.ts core-fetch");
  const codesigned = at("codesign --verify --strict -R");
  const mirrored = at("release-r2.ts core-mirror");
  expect(fetched).toBeGreaterThan(-1);
  expect(codesigned).toBeGreaterThan(fetched);
  expect(mirrored).toBeGreaterThan(codesigned);
  const check = steps[codesigned]?.run ?? "";
  expect(check).toContain('certificate leaf[subject.OU] = "2W9652Q7QR"');
  expect(check).toContain("for name in herdr-core-macos-aarch64.tar.gz herdr-core-macos-x86_64.tar.gz; do");
  expect(check).not.toContain("*");
  expect(mirror?.["runs-on"]).toMatch(/^macos-/);
});

test("every action is pinned to a full commit", () => {
  const uses = steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
  expect(uses.length).toBeGreaterThan(0);
  expect(uses.every((ref) => /@[0-9a-f]{40}$/.test(ref))).toBe(true);
});
