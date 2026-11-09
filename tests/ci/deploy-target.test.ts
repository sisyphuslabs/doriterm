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

/**
 * apps/web/wrangler.jsonc with its staging section, and the production top level, changed as a pull request could
 * change them.
 */
const edited = (
  name: string,
  edit: (staging: Record<string, unknown>, production: Record<string, unknown>) => void,
): string => {
  const config = Bun.JSONC.parse(readFileSync(WEB, "utf8")) as { env: { staging: Record<string, unknown> } };
  edit(config.env.staging, config);
  const file = join(scratch, `${name}.jsonc`);
  writeFileSync(file, JSON.stringify(config));
  return file;
};

type Job = { environment?: string; steps: { run?: string }[] };

/**
 * The arguments a workflow job passes its deploy-target check, as the shell hands them to the script: the config, the
 * env (`""` is production), and the worker and hosts the job expects.
 */
const guarded = (workflow: string, job: string): readonly [file: string, env: string, ...expected: string[]] => {
  const { jobs } = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", workflow), "utf8")) as {
    jobs: Record<string, Job>;
  };
  const runs = jobs[job]?.steps.map((step) => step.run ?? "") ?? [];
  const run = runs.find((candidate) => candidate.startsWith("bun .github/scripts/deploy-target.ts "));
  const [file, env, ...expected] = (run ?? "").slice("bun .github/scripts/deploy-target.ts ".length).trim().split(" ");
  if (file === undefined || env === undefined || expected.length === 0) {
    throw new Error(`${workflow}'s ${job} job runs no deploy-target check`);
  }
  return [file, env === '""' ? "" : env, ...expected];
};

test("the web app's own configuration deploys staging and production to exactly their hosts", () => {
  expect(check(WEB, "staging", STAGING).code).toBe(0);
  expect(check(WEB, "", PRODUCTION).code).toBe(0);
});

// #1219: the landing configuration is a deploy target too, and it runs the same check.
test("the landing configuration deploys the worker and hosts its workflow checks for", () => {
  for (const job of ["staging", "production"]) {
    const [file, env, ...expected] = guarded("deploy-landing.yml", job);
    expect([job, file, env]).toEqual([job, "apps/landing/wrangler.jsonc", job === "staging" ? "staging" : ""]);
    expect([job, check(join(ROOT, file), env, expected).code]).toEqual([job, 0]);
  }
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

// #1218: what the routes cannot show is that a binding still reaches the production worker or its resources.
test("a staging section whose bindings reach production is refused before wrangler runs", () => {
  const service = edited("service", (staging) => {
    staging["services"] = [{ binding: "WEB", service: "doriface-web" }];
  });
  const durableObject = edited("durable-object", (staging) => {
    staging["durable_objects"] = { bindings: [{ name: "ROOM", class_name: "Room", script_name: "doriface-web" }] };
  });
  const kv = edited("kv", (staging, production) => {
    production["kv_namespaces"] = [{ binding: "CACHE", id: "production-kv" }];
    staging["kv_namespaces"] = [{ binding: "CACHE", id: "production-kv" }];
  });
  const r2 = edited("r2", (staging, production) => {
    production["r2_buckets"] = [{ binding: "MEDIA", bucket_name: "doriface-media" }];
    staging["r2_buckets"] = [{ binding: "MEDIA", bucket_name: "doriface-media" }];
  });
  const d1Id = edited("d1-id", (staging, production) => {
    production["d1_databases"] = [{ binding: "DB", database_name: "doriface", database_id: "production-d1" }];
    staging["d1_databases"] = [{ binding: "DB", database_name: "doriface-staging", database_id: "production-d1" }];
  });
  const d1Name = edited("d1-name", (staging, production) => {
    production["d1_databases"] = [{ binding: "DB", database_name: "doriface", database_id: "production-d1" }];
    staging["d1_databases"] = [{ binding: "DB", database_name: "doriface", database_id: "staging-d1" }];
  });
  const producer = edited("queue-producer", (staging, production) => {
    production["queues"] = { producers: [{ binding: "JOBS", queue: "doriface-jobs" }] };
    staging["queues"] = { producers: [{ binding: "JOBS", queue: "doriface-jobs" }] };
  });
  const consumer = edited("queue-consumer", (staging, production) => {
    production["queues"] = { consumers: [{ queue: "doriface-jobs" }] };
    staging["queues"] = { consumers: [{ queue: "doriface-jobs" }] };
  });
  for (const file of [service, durableObject, kv, r2, d1Id, d1Name, producer, consumer]) {
    const refused = check(file, "staging", STAGING);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("::error");
  }
});

test("a staging section that binds its own resources and workers passes", () => {
  const file = edited("staging-bindings", (staging, production) => {
    production["kv_namespaces"] = [{ binding: "CACHE", id: "production-kv" }];
    production["d1_databases"] = [{ binding: "DB", database_name: "doriface", database_id: "production-d1" }];
    staging["kv_namespaces"] = [{ binding: "CACHE", id: "staging-kv" }];
    staging["d1_databases"] = [{ binding: "DB", database_name: "doriface-staging", database_id: "staging-d1" }];
    staging["services"] = [{ binding: "WEB", service: "doriface-web-staging" }];
    staging["durable_objects"] = { bindings: [{ name: "ROOM", class_name: "Room" }] };
  });
  expect(check(file, "staging", STAGING).code).toBe(0);
  expect(check(file, "", PRODUCTION).code).toBe(0);
});

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
