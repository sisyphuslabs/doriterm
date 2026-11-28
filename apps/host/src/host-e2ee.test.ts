import { OPEN_POLICY } from "@doriface/policy";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eeDeps } from "./host-e2ee.ts";
import { machine } from "./testing/mesh-history.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// #2993: without the host's own pending joins, every agent pairing refuses (approveAgent's fail-closed branch), so the
// running host must hand them to the pairing gate.
test("the running host's pairing gate asks the owner through the host's own pending joins", () => {
  const dir = mkdtempSync(join(tmpdir(), "dh-e2ee-deps-"));
  dirs.push(dir);
  const e2ee = e2eeDeps(
    dir,
    machine("alpha").identity,
    undefined,
    { listen: { hostname: "127.0.0.1", port: 0 }, token: "t".repeat(32), hc: "hc", policy: OPEN_POLICY, log: () => {} },
    undefined,
  );
  expect(e2ee.approvals).toBe(e2ee.hostMesh.pending);
});
