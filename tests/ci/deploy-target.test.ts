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

/** The production worker a staging job names in its step's env, so a renamed top level cannot move the baseline. */
const PRODUCTION_WORKER = { PRODUCTION_WORKER: "doriface-web" };

const check = (
  file: string,
  env: string,
  expected: readonly string[],
  vars: Record<string, string> = env === "" ? {} : PRODUCTION_WORKER,
): { code: number; out: string } => {
  const { PRODUCTION_WORKER: _, ...rest } = process.env;
  const run = Bun.spawnSync([process.execPath, SCRIPT, file, env, ...expected], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...rest, ...vars },
  });
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

type Job = { environment?: string; steps: { run?: string; env?: Record<string, string> }[] };

/**
 * The arguments a workflow job passes its deploy-target check, as the shell hands them to the script: the config, the
 * env (`""` is production), and the worker and hosts the job expects; and the variables its step sets.
 */
const guarded = (
  workflow: string,
  job: string,
): { args: readonly [string, string, ...string[]]; vars: Record<string, string> } => {
  const { jobs } = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", workflow), "utf8")) as {
    jobs: Record<string, Job>;
  };
  const step = jobs[job]?.steps.find((candidate) => candidate.run?.startsWith("bun .github/scripts/deploy-target.ts "));
  const [file, env, ...expected] = (step?.run ?? "")
    .slice("bun .github/scripts/deploy-target.ts ".length)
    .trim()
    .split(" ");
  if (file === undefined || env === undefined || expected.length === 0) {
    throw new Error(`${workflow}'s ${job} job runs no deploy-target check`);
  }
  return { args: [file, env === '""' ? "" : env, ...expected], vars: step?.env ?? {} };
};

test("the web app's own configuration deploys staging and production to exactly their hosts", () => {
  expect(check(WEB, "staging", STAGING).code).toBe(0);
  expect(check(WEB, "", PRODUCTION).code).toBe(0);
});

// #1219: the landing configuration is a deploy target too, and it runs the same check.
test("the landing configuration deploys the worker and hosts its workflow checks for", () => {
  for (const job of ["staging", "production"]) {
    const {
      args: [file, env, ...expected],
      vars,
    } = guarded("deploy-landing.yml", job);
    expect([job, file, env]).toEqual([job, "apps/landing/wrangler.jsonc", job === "staging" ? "staging" : ""]);
    expect([job, check(join(ROOT, file), env, expected, vars).code]).toEqual([job, 0]);
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
  const workflow = edited("workflow", (staging) => {
    staging["workflows"] = [{ name: "sync", binding: "SYNC", class_name: "Sync", script_name: "doriface-web" }];
  });
  const tail = edited("tail-consumer", (staging) => {
    staging["tail_consumers"] = [{ service: "doriface-web" }];
  });
  const hyperdrive = edited("hyperdrive", (staging, production) => {
    production["hyperdrive"] = [{ binding: "PG", id: "production-pg" }];
    staging["hyperdrive"] = [{ binding: "PG", id: "production-pg" }];
  });
  const vectorize = edited("vectorize", (staging, production) => {
    production["vectorize"] = [{ binding: "INDEX", index_name: "doriface-index" }];
    staging["vectorize"] = [{ binding: "INDEX", index_name: "doriface-index" }];
  });
  const files = [
    service,
    durableObject,
    kv,
    r2,
    d1Id,
    d1Name,
    producer,
    consumer,
    workflow,
    tail,
    hyperdrive,
    vectorize,
  ];
  for (const file of files) {
    const refused = check(file, "staging", STAGING);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("::error");
  }
});

// The baseline for "production" is the worker the workflow names, not the pull request's own top level: renaming the
// top level in the same edit would otherwise let staging bind the real production worker.
test("a staging check takes the production worker from its job and refuses a renamed top level", () => {
  const renamed = edited("renamed-top", (staging, production) => {
    production["name"] = "doriface-web-renamed";
    staging["services"] = [{ binding: "WEB", service: "doriface-web" }];
  });
  const refused = check(renamed, "staging", STAGING);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("::error");
  expect(check(WEB, "staging", STAGING, {}).code).toBe(2);
  const { vars } = guarded("deploy-web.yml", "staging");
  expect(vars).toEqual(PRODUCTION_WORKER);
});

test("a staging section that binds its own resources and workers passes", () => {
  const file = edited("staging-bindings", (staging, production) => {
    production["kv_namespaces"] = [{ binding: "CACHE", id: "production-kv" }];
    production["d1_databases"] = [{ binding: "DB", database_name: "doriface", database_id: "production-d1" }];
    staging["kv_namespaces"] = [{ binding: "CACHE", id: "staging-kv" }];
    staging["d1_databases"] = [{ binding: "DB", database_name: "doriface-staging", database_id: "staging-d1" }];
    staging["services"] = [{ binding: "WEB", service: "doriface-web-staging" }];
    staging["durable_objects"] = { bindings: [{ name: "ROOM", class_name: "Room" }] };
    production["r2_buckets"] = [{ binding: "MEDIA", bucket_name: "doriface-media" }];
    production["queues"] = { producers: [{ binding: "JOBS", queue: "doriface-jobs" }] };
    staging["r2_buckets"] = [{ binding: "MEDIA", bucket_name: "doriface-media-staging" }];
    staging["queues"] = {
      producers: [{ binding: "JOBS", queue: "doriface-jobs-staging" }],
      consumers: [{ queue: "doriface-jobs-staging" }],
    };
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
