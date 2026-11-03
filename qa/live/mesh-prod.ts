#!/usr/bin/env bun
/**
 * Runs the mesh's 12-echo check against the production relay, by hand: four doriface-host processes with their own
 * state dirs and hc cores join one mesh, then every directed pair runs a fresh nonce on the other's core.
 *
 *   bun qa/live/mesh-prod.ts [--relay <url>]
 *
 * It registers four throwaway hosts on the relay (scratch state, removed at the end) and needs the mesh commands, so
 * it refuses to start on a branch that lacks them. Exit 0 only when all 12 echoes came back.
 */
import { DEFAULT_RELAY_URL } from "../../packages/crypto/src/index.ts";
import { parseArgs } from "node:util";
import { detect, missing } from "../../tests/relay/support/mesh/capabilities.ts";
import { directedPairs, echoAll, untilFullMesh } from "../../tests/relay/support/mesh/echo.ts";
import { HOST_NAMES, startMesh } from "../../tests/relay/support/mesh/mesh.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { relay: { type: "string", default: DEFAULT_RELAY_URL } },
});
const present = await detect();
const absent = missing(present, ["cli", "bridge", "reconciler"]);
if (absent.length > 0) {
  console.error(`mesh-prod: this branch lacks ${absent.join(", ")}; run it on a branch with the mesh commands`);
  process.exit(2);
}

const relayUrl = values.relay ?? DEFAULT_RELAY_URL;
const mesh = await startMesh({ relayUrl });
let failed = true;
try {
  await mesh.join("a", "b");
  await mesh.join("a", "c");
  await mesh.join("a", "d");
  await untilFullMesh(mesh, HOST_NAMES);
  const results = await echoAll(mesh, HOST_NAMES);
  for (const result of results) console.log(`${result.from} -> ${result.to}  ${result.ok ? "ok" : "FAILED"}`);
  const bad = results.filter((result) => !result.ok);
  console.log(`${results.length - bad.length} of ${directedPairs(HOST_NAMES).length} echoes ok through ${relayUrl}`);
  failed = bad.length > 0 || results.length !== directedPairs(HOST_NAMES).length;
} finally {
  const receipt = await mesh.dispose();
  console.log(`teardown: pids=${receipt.pids.join(",")} alive=${receipt.alive.length}`);
}
process.exit(failed ? 1 : 0);
