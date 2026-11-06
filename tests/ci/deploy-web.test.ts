import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; run?: string; uses?: string };
type Job = { needs?: string; if?: string; steps: Step[] };
type Workflow = { concurrency: { group: string; "cancel-in-progress": string | boolean }; jobs: Record<string, Job> };
type Route = { pattern: string; custom_domain?: boolean };
type Assets = { directory: string; not_found_handling?: string };
type Wrangler = { assets: Assets; routes: Route[]; env: { staging: { assets: Assets; routes: Route[] } } };

const ROOT = join(import.meta.dir, "..", "..");
const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "deploy-web.yml"), "utf8")) as Workflow;
const wrangler = Bun.JSONC.parse(readFileSync(join(ROOT, "apps", "web", "wrangler.jsonc"), "utf8")) as Wrangler;

const runs = (job: Job): string[] => job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));

test("a pull request's run never shares dev's concurrency group, and dev deploys are never cancelled in progress", () => {
  expect(workflow.concurrency.group).toBe(
    "${{ github.event_name == 'pull_request' && format('deploy-web-pr-{0}', github.event.pull_request.number) || 'deploy-web-dev' }}",
  );
  expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
});

test("production deploys only from dev, after staging was deployed and probed, from staging's own build", () => {
  const { staging, production } = workflow.jobs;
  if (staging === undefined || production === undefined) throw new Error("deploy-web.yml lacks a job");
  expect(production.needs).toBe("staging");
  expect(production.if).toContain("github.ref == 'refs/heads/dev'");
  expect(runs(staging)).toEqual(
    expect.arrayContaining([
      'bunx "$WRANGLER" deploy --env staging',
      "bun .github/scripts/probe-web.ts https://doriface-staging.omo.dev",
    ]),
  );
  expect(runs(staging)).not.toContain('bunx "$WRANGLER" deploy --env ""');
  expect(runs(production)).toEqual([
    'bunx "$WRANGLER" deploy --env ""',
    "bun .github/scripts/probe-web.ts https://doriface.omo.dev",
  ]);
  expect(production.steps.some((step) => step.uses?.startsWith("actions/download-artifact"))).toBe(true);
});

test("both hostnames serve the build with the SPA fallback, so /pair loads the app", () => {
  expect(wrangler.routes).toEqual([{ pattern: "doriface.omo.dev", custom_domain: true }]);
  expect(wrangler.env.staging.routes).toEqual([{ pattern: "doriface-staging.omo.dev", custom_domain: true }]);
  for (const assets of [wrangler.assets, wrangler.env.staging.assets]) {
    expect(assets).toEqual({ directory: "./dist", not_found_handling: "single-page-application" });
  }
});

test("every page runs only this origin's scripts and connects only to this origin and the relay", () => {
  const headersFile = readFileSync(join(ROOT, "apps", "web", "public", "_headers"), "utf8");
  const policy = /^\/\*\n(?:  .*\n)*?  Content-Security-Policy: (.+)$/m.exec(headersFile)?.[1] ?? "";
  const directives = new Map(
    policy.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
  expect(directives.get("default-src")).toEqual(["'none'"]);
  expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(directives.get("connect-src")).toEqual([
    "'self'",
    "https://relay-doriface.omo.dev",
    "wss://relay-doriface.omo.dev",
  ]);
  expect(directives.get("style-src")).toEqual(["'self'", `'sha256-${baseUiScrollbarStyleHash()}'`]);
  expect(directives.get("img-src")).toEqual(["'self'", "blob:"]);
  expect(directives.get("font-src")).toEqual(["'self'", "data:"]);
  for (const name of ["frame-ancestors", "base-uri", "form-action", "object-src"]) {
    expect(directives.get(name)).toEqual(["'none'"]);
  }
  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy).not.toContain("'unsafe-inline'");
});

/** The CSP hash of the <style> @base-ui/react renders to hide scrollbars, rebuilt from the installed package's source. */
function baseUiScrollbarStyleHash(): string {
  const pkg = realpathSync(join(ROOT, "packages", "ui", "node_modules", "@base-ui", "react"));
  const source = readFileSync(join(pkg, "utils", "styles.js"), "utf8");
  const className = /DISABLE_SCROLLBAR_CLASS_NAME = '([^']+)'/.exec(source)?.[1];
  const template = /children: `([^`]+)`/.exec(source)?.[1];
  if (className === undefined || template === undefined) throw new Error("@base-ui/react's scrollbar style moved");
  const css = template.replaceAll("${DISABLE_SCROLLBAR_CLASS_NAME}", className);
  return new Bun.CryptoHasher("sha256").update(css).digest("base64");
}
