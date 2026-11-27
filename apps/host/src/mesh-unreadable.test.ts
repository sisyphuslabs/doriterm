import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { type Host, startHost } from "./host.ts";
import { MeshStore } from "./state/mesh.ts";
import { MESH_FILE } from "./state/mesh-file.ts";
import { createHcSession, type HcSession } from "./testing/hc-session.ts";

const token = generateToken();
let session: HcSession;
let stateDir: string;
let host: Host | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "dh-mesh-unreadable-"));
  session = createHcSession("doriface-mesh-unreadable-test");
});
afterEach(async () => {
  await host?.stop();
  host = undefined;
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a host over an unreadable mesh.json still starts, says why, keeps the file as it is and admits no member from it", async () => {
  writeFileSync(join(stateDir, MESH_FILE), "{", { mode: 0o600 });
  const logs: string[] = [];
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    log: (line) => logs.push(line),
  });

  expect((await fetch(`http://127.0.0.1:${host.port}/healthz`)).status).toBe(200);
  const said = logs.filter((line) => line.startsWith(`mesh: cannot read ${MESH_FILE}`));
  expect(said).toEqual([
    `mesh: cannot read ${MESH_FILE} (JSON Parse error: Expected '}'); this host runs as in no mesh and leaves it as it is`,
  ]);
  expect(readFileSync(join(stateDir, MESH_FILE), "utf8")).toBe("{");
  expect(new MeshStore(stateDir, { log: () => {} }).authorizeIndex()).toBeUndefined();
});
