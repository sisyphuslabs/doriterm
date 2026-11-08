#!/usr/bin/env bun
/**
 * Refuses a deploy whose wrangler configuration would reach anything but the expected worker and hosts (#816). A staging
 * job deploys a pull request's own wrangler.jsonc with the deploy token, so a staging section naming a production host
 * or the production worker would deploy to production from the staging job, past the manual production gate. This runs
 * before wrangler and compares the section that `wrangler deploy --env <env>` reads (the top level for "") with the
 * worker name and the exact route patterns given, and with workers.dev and preview URLs off.
 *
 * Usage: bun .github/scripts/deploy-target.ts <wrangler.jsonc> <env or ""> <worker name> <host>...
 */
import { readFileSync } from "node:fs";

const [file, env, worker, ...hosts] = Bun.argv.slice(2);
if (file === undefined || env === undefined || worker === undefined || hosts.length === 0) {
  console.error('usage: deploy-target.ts <wrangler.jsonc> <env or ""> <worker name> <host>...');
  process.exit(2);
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

const config = record(Bun.JSONC.parse(readFileSync(file, "utf8")));
const section = env === "" ? config : record(record(config["env"])[env]);
const routes: unknown = section["routes"] ?? [];
const patterns = Array.isArray(routes) ? routes.map((route) => record(route)["pattern"]) : [];

const problems = [
  ...(section["name"] === worker ? [] : [`the worker is ${JSON.stringify(section["name"])}, not ${worker}`]),
  ...(section["route"] === undefined ? [] : ['a "route" field is set; only "routes" is expected']),
  ...(section["workers_dev"] === false ? [] : ["workers_dev is not false"]),
  ...(section["preview_urls"] === false ? [] : ["preview_urls is not false"]),
  ...(Array.isArray(routes) ? [] : ['"routes" is not a list']),
  ...patterns
    .filter((pattern) => typeof pattern !== "string" || !hosts.includes(pattern))
    .map((pattern) => `route ${JSON.stringify(pattern)} is not one of ${hosts.join(", ")}`),
  ...hosts.filter((host) => !patterns.includes(host)).map((host) => `no route for ${host}`),
];

const target = env === "" ? "production" : env;
if (problems.length > 0) {
  console.log(`::error title=Deploy target::${file} (${target}) would deploy elsewhere: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`${file} (${target}) deploys ${worker} to ${hosts.join(", ")} only`);
