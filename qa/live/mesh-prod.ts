#!/usr/bin/env bun
/**
 * Runs the mesh's 12-echo check against the production relay, by hand: four doriface-host processes with their own
 * state dirs and hc cores join one mesh, then every directed pair runs a fresh nonce and a terminal on the other's core.
 *
 *   bun qa/live/mesh-prod.ts [--relay <url>]
 *
 * It registers four throwaway hosts on the relay (scratch state, removed at the end, also on Ctrl-C) and needs the
 * mesh commands, so it refuses to start on a branch that lacks them. Exit 0 only when all 12 pairs came back.
 */
import { DEFAULT_RELAY_URL } from "../../packages/crypto/src/index.ts";
import { parseArgs } from "node:util";
import { detect, missing } from "../../tests/relay/support/mesh/capabilities.ts";
import { directedPairs, echoAll, untilFullMesh } from "../../tests/relay/support/mesh/echo.ts";
import { HOST_NAMES, type Mesh, startMesh } from "../../tests/relay/support/mesh/mesh.ts";

const INTERRUPTED = 130;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { relay: { type: "string", default: DEFAULT_RELAY_URL } },
});
const absent = missing(await detect(), ["join", "status", "bridge", "reconciler", "sync"]);
if (absent.length > 0) {
  console.error(`mesh-prod: this branch lacks ${absent.join("; ")}; run it on a branch with the mesh commands`);
  process.exit(2);
}

const relayUrl = values.relay ?? DEFAULT_RELAY_URL;
const starting: Promise<Mesh> = startMesh({ relayUrl });
let teardown: Promise<void> | undefined;
/** Waits for a mesh that is still starting, so a Ctrl-C during the start leaves nothing behind either. */
const tearDown = (): Promise<void> => {
  teardown ??= starting.then(
    async (mesh) => {
      const receipt = await mesh.dispose();
      console.log(
        `teardown: processes=${receipt.owned.length} alive=${receipt.alive.length} listening=${receipt.listening.length}`,
      );
      return undefined;
    },
    () => undefined,
  );
  return teardown;
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.error(`mesh-prod: ${signal}, tearing the four hosts down`);
    void tearDown().finally(() => process.exit(INTERRUPTED));
  });
}

let failed = true;
try {
  const mesh = await starting;
  await mesh.join("a", "b");
  await mesh.join("a", "c");
  await mesh.join("a", "d");
  await untilFullMesh(mesh, HOST_NAMES);
  const results = await echoAll(mesh, HOST_NAMES);
  for (const result of results) {
    console.log(`${result.from} -> ${result.to}  ${result.ok && result.terminal ? "ok" : "FAILED"}`);
  }
  const bad = results.filter((result) => !result.ok || !result.terminal);
  console.log(`${results.length - bad.length} of ${directedPairs(HOST_NAMES).length} pairs ok through ${relayUrl}`);
  failed = bad.length > 0 || results.length !== directedPairs(HOST_NAMES).length;
} finally {
  await tearDown();
}
process.exit(failed ? 1 : 0);
