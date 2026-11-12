import { basename, delimiter } from "node:path";

/**
 * `env` with the directory `bunx --bun` puts first on PATH left out: its `node` is bun, and wrangler run under bun never
 * gets the relay up (#2327). Every process a `bunx --bun playwright test` worker spawns inherits that PATH.
 */
export function withoutBunNodeShim(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const path = env["PATH"];
  if (path === undefined) return { ...env };
  const kept = path.split(delimiter).filter((dir) => !basename(dir).startsWith("bun-node-"));
  return { ...env, PATH: kept.join(delimiter) };
}
