import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; run?: string; uses?: string };
type Job = { needs?: string; if?: string; steps: Step[] };
type Workflow = {
  on: { push: { branches: string[]; paths: string[] }; pull_request: { paths?: string[] } };
  jobs: Record<string, Job>;
};
type Route = { pattern: string; custom_domain?: boolean; zone_id?: string };
type Assets = { directory: string; html_handling?: string };
type Wrangler = { assets: Assets; routes: Route[]; env: { staging: { assets: Assets; routes: Route[] } } };

const ROOT = join(import.meta.dir, "..", "..");
const workflow = Bun.YAML.parse(
  readFileSync(join(ROOT, ".github", "workflows", "deploy-landing.yml"), "utf8"),
) as Workflow;
const wrangler = Bun.JSONC.parse(readFileSync(join(ROOT, "apps", "landing", "wrangler.jsonc"), "utf8")) as Wrangler;

const runs = (job: Job): string[] => job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));

test("a push deploys and probes staging only; doriterm.com needs a manual run on dev after staging passed", () => {
  const { staging, production } = workflow.jobs;
  if (staging === undefined || production === undefined) throw new Error("deploy-landing.yml lacks a job");
  expect(runs(staging)).toEqual(
    expect.arrayContaining([
      'bunx "$WRANGLER" deploy --env staging',
      "bun .github/scripts/probe-landing.ts https://staging.doriterm.com",
    ]),
  );
  expect(runs(staging)).not.toContain('bunx "$WRANGLER" deploy --env ""');
  expect(production.needs).toBe("staging");
  expect(production.if).toContain("github.ref == 'refs/heads/dev'");
  expect(production.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(production.if).toContain("inputs.production");
  expect(production.steps.some((step) => step.uses?.startsWith("actions/download-artifact"))).toBe(true);
});

test("production deploys only after app.doriterm.com, where every Open the app button points, answers", () => {
  const steps = runs(workflow.jobs["production"] ?? { steps: [] });
  const guard = steps.findIndex((run) => run.includes("https://app.doriterm.com"));
  const deploy = steps.indexOf('bunx "$WRANGLER" deploy --env ""');
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(deploy).toBeGreaterThan(guard);
  expect(steps.at(-1)).toBe("bun .github/scripts/probe-landing.ts https://doriterm.com");
});

test("the apex and www serve the landing and staging.doriterm.com its staging copy, each pinned to the zone", () => {
  const zone_id = "79ae74d5937b2858a42f6261887e436e";
  expect(wrangler.routes).toEqual([
    { pattern: "doriterm.com", custom_domain: true, zone_id },
    { pattern: "www.doriterm.com", custom_domain: true, zone_id },
  ]);
  expect(wrangler.env.staging.routes).toEqual([{ pattern: "staging.doriterm.com", custom_domain: true, zone_id }]);
});

test("the page frames the mockup at its folder index, which the host serves without a redirect", () => {
  for (const assets of [wrangler.assets, wrangler.env.staging.assets])
    expect(assets.html_handling).toBe("auto-trailing-slash");
  const page = readFileSync(join(ROOT, "apps", "landing", "index.html"), "utf8");
  const sources = [...page.matchAll(/data-src="([^"]+)"/g)].map((match) => match[1]);
  expect(sources).toEqual(["/mockup/?view=desktop", "/mockup/?view=phone"]);
  expect(readFileSync(join(ROOT, "apps", "landing", "mockup", "index.html"), "utf8")).toContain("/src/mockup/main.tsx");
  const probe = readFileSync(join(ROOT, ".github", "scripts", "probe-landing.ts"), "utf8");
  expect(probe).toContain('path: "/mockup/"');
});

test("a labelled PR deploys staging only when it touches the landing, and a manual run only from dev", () => {
  expect(workflow.on.pull_request.paths).toEqual(workflow.on.push.paths);
  expect(workflow.on.pull_request.paths).toContain("apps/landing/**");
  const staging = workflow.jobs["staging"]?.if ?? "";
  expect(staging).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/dev'");
  expect(staging).toContain("github.event.pull_request.head.repo.full_name == github.repository");
});
