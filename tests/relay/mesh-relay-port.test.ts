import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MeshRelay, startMeshRelay } from "./support/mesh/relay-front.ts";

test("a relay starts despite port competition and keeps its public address across restart (#1015)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-port-race-"));
  const previous = process.env["DORIFACE_RELAY_DIR"];
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ main: "worker.ts" }));
  writeFileSync(
    join(dir, "node_modules", ".bin", "wrangler"),
    readFileSync(join(import.meta.dir, "fixtures", "port-race-wrangler.fixture.ts")),
    { mode: 0o755 },
  );
  process.env["DORIFACE_RELAY_DIR"] = dir;
  let relay: MeshRelay | undefined;
  try {
    relay = await startMeshRelay();
    const url = relay.url;
    const tap = relay.tapFor();
    const direct = await fetch(`${url}/healthz`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(await direct.json()).toMatchObject({ host: new URL(url).host, ip: "203.0.113.9" });
    const first = await fetch(`${tap.url}/healthz`);
    expect(await first.json()).toMatchObject({ host: new URL(tap.url).host, ip: relay.ip });
    await relay.restart();
    expect(relay.url).toBe(url);
    const next = await fetch(`${tap.url}/healthz`);
    expect(await next.json()).toMatchObject({ host: new URL(tap.url).host, ip: relay.ip });
    await relay.stop();
    relay = undefined;
    expect(
      await fetch(`${url}/healthz`).then(
        () => "open",
        () => "closed",
      ),
    ).toBe("closed");
    expect(
      await fetch(`${tap.url}/healthz`).then(
        () => "open",
        () => "closed",
      ),
    ).toBe("closed");
  } finally {
    await relay?.stop();
    if (previous === undefined) delete process.env["DORIFACE_RELAY_DIR"];
    else process.env["DORIFACE_RELAY_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
