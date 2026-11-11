#!/usr/bin/env bun
/**
 * The checks .github/workflows/deploy-get.yml runs around `wrangler deploy` for apps/get (get.doriterm.com, #1969).
 *
 *   bindings <wrangler.jsonc> <env or "">  the section deploys this environment's own bucket, database and dataset, never
 *                                          the other environment's, with observability, Logpush and tail consumers off
 *   private <bucket>                       the bucket has no r2.dev URL and no custom domain (Cloudflare API)
 *   live <worker>                          prints the version the Worker serves now, or "none", for a rollback
 *
 * The API calls read CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment and print neither.
 */
import { readFileSync } from "node:fs";

export interface Bindings {
  readonly worker: string;
  readonly bucket: string;
  readonly database: string;
  readonly dataset: string;
}

export const EXPECTED: Readonly<Record<"production" | "staging", Bindings>> = {
  production: {
    worker: "doriterm-get",
    bucket: "doriterm-releases",
    database: "doriterm-get",
    dataset: "doriterm_downloads",
  },
  staging: {
    worker: "doriterm-get-staging",
    bucket: "doriterm-releases-staging",
    database: "doriterm-get-staging",
    dataset: "doriterm_downloads_staging",
  },
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const names = (value: unknown, field: string): unknown[] => list(value).map((entry) => record(entry)[field]);

/** Every way the section could reach the wrong environment's data or keep request logs; empty when it cannot. */
export function bindingProblems(config: unknown, env: string): string[] {
  const target = env === "" ? "production" : env;
  if (target !== "production" && target !== "staging") return [`unknown environment ${env}`];
  const section = env === "" ? record(config) : record(record(record(config)["env"])[env]);
  const want = EXPECTED[target];
  const vars = record(section["vars"]);
  const problems: string[] = [];
  const exact = (what: string, got: unknown[], expected: string) => {
    if (got.length !== 1 || got[0] !== expected) problems.push(`${what} is ${JSON.stringify(got)}, not [${expected}]`);
  };
  if (section["name"] !== want.worker)
    problems.push(`the worker is ${JSON.stringify(section["name"])}, not ${want.worker}`);
  exact("the R2 bucket", names(section["r2_buckets"], "bucket_name"), want.bucket);
  exact("the D1 database", names(section["d1_databases"], "database_name"), want.database);
  exact("the Analytics Engine dataset", names(section["analytics_engine_datasets"], "dataset"), want.dataset);
  if (vars["ANALYTICS_DATASET"] !== want.dataset) problems.push(`ANALYTICS_DATASET is not ${want.dataset}`);
  if (record(section["observability"])["enabled"] !== false) problems.push("observability is not off");
  // Either would ship request events off the Worker (#1981); a named environment that sets neither is held to the
  // top-level values.
  const top = record(config);
  if ((section["logpush"] ?? top["logpush"]) === true) problems.push("logpush is on");
  const tails = list(section["tail_consumers"] ?? top["tail_consumers"]);
  if (tails.length > 0) problems.push(`it has tail consumers (${tails.length})`);
  for (const key of ["account_id", "ACCOUNT_ID", "ANALYTICS_TOKEN"]) {
    if (key in section || key in vars || key in record(config)) problems.push(`${key} is written in the file`);
  }
  return problems;
}

async function cloudflare(path: string): Promise<unknown> {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  const account = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Cloudflare API ${path.replace(/\/[^/]+$/, "/…")} answered ${response.status}`);
  return record(await response.json())["result"];
}

/** The bucket's public access: an r2.dev URL or any custom domain makes every object readable without the Worker. */
export function exposure(managed: unknown, custom: unknown): string[] {
  const problems: string[] = [];
  if (record(managed)["enabled"] !== false) problems.push("its r2.dev URL is not disabled");
  const domains = names(record(custom)["domains"], "domain");
  if (domains.length > 0) problems.push(`it has custom domains (${domains.length})`);
  return problems;
}

/** The version a deployment serves to most requests, from GET .../workers/scripts/<name>/deployments. */
export function liveVersion(deployments: unknown): string {
  const latest = record(list(record(deployments)["deployments"])[0]);
  const versions = list(latest["versions"]).map(record);
  const top = versions.toSorted((a, b) => Number(b["percentage"] ?? 0) - Number(a["percentage"] ?? 0))[0];
  const id = top?.["version_id"];
  return typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? id : "none";
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "bindings" && args[0] !== undefined && args[1] !== undefined) {
    const problems = bindingProblems(Bun.JSONC.parse(readFileSync(args[0], "utf8")), args[1]);
    if (problems.length > 0) {
      console.log(`::error title=Deploy bindings::${args[0]} (${args[1] || "production"}): ${problems.join("; ")}`);
      return 1;
    }
    console.log(`${args[0]} (${args[1] || "production"}) binds only its own bucket, database and dataset`);
    return 0;
  }
  if (command === "private" && args[0] !== undefined) {
    const bucket = encodeURIComponent(args[0]);
    const problems = exposure(
      await cloudflare(`/r2/buckets/${bucket}/domains/managed`),
      await cloudflare(`/r2/buckets/${bucket}/domains/custom`),
    );
    if (problems.length > 0) {
      console.log(`::error title=Public bucket::${args[0]} is readable without the Worker: ${problems.join("; ")}`);
      return 1;
    }
    console.log(`${args[0]} is private: no r2.dev URL and no custom domain`);
    return 0;
  }
  if (command === "live" && args[0] !== undefined) {
    let deployments: unknown = {};
    try {
      deployments = await cloudflare(`/workers/scripts/${encodeURIComponent(args[0])}/deployments`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // A Worker's first deploy has nothing to roll back to.
      console.error(error.message);
    }
    console.log(liveVersion(deployments));
    return 0;
  }
  console.error('usage: get-deploy.ts bindings <wrangler.jsonc> <env or ""> | private <bucket> | live <worker>');
  return 2;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
