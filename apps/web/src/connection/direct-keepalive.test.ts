import { DIRECT_IDLE_MS, startHost, type Host } from "@doriface/host";
import { createHcSession, type HcSession } from "@doriface/host/testing";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECT_PING_MS, openDirectLink } from "./direct-attempt.ts";

const IDLE_MS = 300;
const stateDir = mkdtempSync(join(tmpdir(), "dw-direct-keepalive-"));
let hc: HcSession;
let host: Host;

beforeAll(async () => {
  hc = createHcSession("doriface-web-direct-keepalive");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: "web-direct-keepalive-token-web-direct-keepalive",
    hc: hc.hc,
    session: hc.name,
    env: hc.env,
    stateDir,
    directIdleMs: IDLE_MS,
    log: () => {},
  });
});

afterAll(async () => {
  await host.stop();
  await hc.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

function e2eeUrl(): string {
  const url = host.e2ee?.url;
  if (url === undefined) throw new Error("no e2ee endpoint");
  return url;
}

/** A socket that never sends anything: the host closes it once its idle deadline passes, which marks that moment. */
function silentSocket(): Promise<number> {
  const socket = new WebSocket(e2eeUrl());
  return new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
}

test("an idle direct link keeps its socket past the host's idle deadline (#1040)", async () => {
  const link = await openDirectLink(e2eeUrl(), undefined, IDLE_MS / 6);
  const linkClosed = new Promise<string>((resolve) =>
    link.onClose((error) => resolve(`link closed: ${String(error)}`)),
  );
  // Opened after the link, so its deadline passes after the link's would have.
  const silent = silentSocket().then((code) => `silent socket closed with ${code}`);
  expect(await Promise.race([linkClosed, silent])).toBe("silent socket closed with 4408");
  link.close();
});

test("the direct link pings well inside the host's idle deadline", () => {
  expect(DIRECT_PING_MS * 3).toBeLessThanOrEqual(DIRECT_IDLE_MS);
});
