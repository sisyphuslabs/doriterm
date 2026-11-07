import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, ".github", "scripts", "deploy-target.ts");
const WEB = join(ROOT, "apps", "web", "wrangler.jsonc");
const STAGING = ["doriface-web-staging", "staging.app.doriterm.com", "doriface-staging.omo.dev"];
const PRODUCTION = ["doriface-web", "app.doriterm.com", "doriface.omo.dev"];

const scratch = mkdtempSync(join(tmpdir(), "deploy-target-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const check = (file: string, env: string, expected: readonly string[]): { code: number; out: string } => {
  const run = Bun.spawnSync([process.execPath, SCRIPT, file, env, ...expected], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
};

/** apps/web/wrangler.jsonc with its staging section changed as a pull request could change it. */
const edited = (name: string, edit: (staging: Record<string, unknown>) => void): string => {
  const config = Bun.JSONC.parse(readFileSync(WEB, "utf8")) as { env: { staging: Record<string, unknown> } };
  edit(config.env.staging);
  const file = join(scratch, `${name}.jsonc`);
  writeFileSync(file, JSON.stringify(config));
  return file;
};

test("the web app's own configuration deploys staging and production to exactly their hosts", () => {
  expect(check(WEB, "staging", STAGING).code).toBe(0);
  expect(check(WEB, "", PRODUCTION).code).toBe(0);
});

// #816: a staging job runs the pull request's own wrangler.jsonc with the deploy token.
test("a staging section that would reach a production host or worker is refused before wrangler runs", () => {
  const route = edited("route", (staging) => {
    staging["routes"] = [{ pattern: "app.doriterm.com", custom_domain: true }];
  });
  const worker = edited("worker", (staging) => {
    staging["name"] = "doriface-web";
  });
  const extra = edited("extra", (staging) => {
    staging["routes"] = [...(staging["routes"] as unknown[]), { pattern: "doriface.omo.dev/*", zone_name: "omo.dev" }];
  });
  const devSubdomain = edited("workers-dev", (staging) => {
    staging["workers_dev"] = true;
  });
  for (const file of [route, worker, extra, devSubdomain]) {
    const refused = check(file, "staging", STAGING);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("::error");
  }
});

type Job = { environment?: string; steps: { run?: string }[] };

test("every deploy job checks its target first and takes its secrets from its own environment", () => {
  for (const name of ["deploy-web.yml", "deploy-landing.yml"]) {
    const { jobs } = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", name), "utf8")) as {
      jobs: Record<string, Job>;
    };
    for (const [job, environment] of [
      ["staging", "staging"],
      ["production", "production"],
    ] as const) {
      const steps = jobs[job]?.steps.map((step) => step.run ?? "") ?? [];
      const deploy = steps.findIndex((run) => run.startsWith('bunx "$WRANGLER" deploy'));
      const env = environment === "staging" ? "staging" : '""';
      expect([name, job, jobs[job]?.environment]).toEqual([name, job, environment]);
      expect(steps[deploy - 1]).toStartWith(`bun .github/scripts/deploy-target.ts `);
      expect(steps[deploy - 1]?.split(" ")[3]).toBe(env);
      expect(steps[deploy]).toBe(`bunx "$WRANGLER" deploy --env ${env}`);
    }
  }
});
