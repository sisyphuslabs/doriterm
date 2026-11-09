import { mock, test } from "bun:test";
import * as fs from "node:fs";
import { createHcSession } from "./hc-session.ts";

const real = { ...fs };
/** While set, a watchFile watcher is never polled, as Bun's stat scheduler leaves one it strands under load (#1547). */
let stranded = false;
await mock.module("node:fs", () => ({
  ...real,
  watchFile: (...args: Parameters<typeof fs.watchFile>) => (stranded ? undefined : real.watchFile(...args)),
}));
const { ownMeshSession } = await import("./mesh-session.ts");

test("a mesh session is ready once its core serves, even when no stat watcher reports the socket", async () => {
  const scratch = createHcSession("mesh-ready");
  // ownMeshSession starts any watcher before its first await, so only its own is stranded.
  stranded = true;
  const ready = ownMeshSession(scratch);
  stranded = false;
  // Rejects with "mesh core did not create its socket" when readiness waits on the watcher.
  const session = await ready;
  await session.dispose();
}, 60_000);
