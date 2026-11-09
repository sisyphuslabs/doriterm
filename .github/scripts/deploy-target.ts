#!/usr/bin/env bun
/**
 * Refuses a deploy whose wrangler configuration would reach anything but the expected worker and hosts (#816, #1218). A
 * staging job deploys a pull request's own wrangler.jsonc with the deploy token, so a staging section naming a
 * production host, the production worker, or a production resource would reach production from the staging job, past
 * the manual production gate. This runs before wrangler and compares the section that `wrangler deploy --env <env>`
 * reads (the top level for "") with the worker name and the exact route patterns given, with workers.dev and preview
 * URLs off, and, for a non-production env, its bindings with the production section's worker and resources.
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

const bindings = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);

const at = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((node, key) => record(node)[key], value);

/** Every identifier a binding list sets in `fields`, paired with the field that holds it. */
const identifiers = (
  from: Record<string, unknown>,
  path: readonly string[],
  fields: readonly string[],
): { field: string; value: string }[] =>
  bindings(at(from, path)).flatMap((binding) =>
    fields.flatMap((field) => {
      const value = binding[field];
      return typeof value === "string" ? [{ field, value }] : [];
    }),
  );

/** Bindings that name another script, and so must not name the production worker. */
const SCRIPT_BINDINGS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [["services"], ["service"]],
  [["durable_objects", "bindings"], ["script_name"]],
];

/** Bindings that name a resource in the account, and so must not name one the production section already binds. */
const RESOURCE_BINDINGS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [["kv_namespaces"], ["id"]],
  [["r2_buckets"], ["bucket_name"]],
  [["d1_databases"], ["database_id", "database_name"]],
  [["queues", "producers"], ["queue"]],
  [["queues", "consumers"], ["queue"]],
];

const config = record(Bun.JSONC.parse(readFileSync(file, "utf8")));
const section = env === "" ? config : record(record(config["env"])[env]);
const routes: unknown = section["routes"] ?? [];
const patterns = Array.isArray(routes) ? routes.map((route) => record(route)["pattern"]) : [];

/** What a non-production section must not reach: the production worker and the resources production binds. */
const productionProblems =
  env === ""
    ? []
    : [
        ...SCRIPT_BINDINGS.flatMap(([path, fields]) =>
          identifiers(section, path, fields)
            .filter(({ value }) => value === config["name"])
            .map(
              ({ field, value }) => `${path.join(".")}[].${field} ${JSON.stringify(value)} is the production worker`,
            ),
        ),
        ...RESOURCE_BINDINGS.flatMap(([path, fields]) => {
          const production = new Set(identifiers(config, path, fields).map(({ value }) => value));
          return identifiers(section, path, fields)
            .filter(({ value }) => production.has(value))
            .map(
              ({ field, value }) => `${path.join(".")}[].${field} ${JSON.stringify(value)} is a production resource`,
            );
        }),
      ];

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
  ...productionProblems,
];

const target = env === "" ? "production" : env;
if (problems.length > 0) {
  console.log(`::error title=Deploy target::${file} (${target}) would deploy elsewhere: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`${file} (${target}) deploys ${worker} to ${hosts.join(", ")} only`);
