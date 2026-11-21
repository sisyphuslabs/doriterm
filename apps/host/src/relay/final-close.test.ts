import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, type Host } from "../host.ts";
import { generateToken } from "../auth.ts";
import { FakeRelay } from "../testing/fake-relay.ts";
import { createHcSession, type HcSession } from "../testing/hc-session.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
let relay: FakeRelay;
let session: HcSession;
let host: Host;
let stateDir: string;
let stopped: Promise<void>;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "dh-final-close-"));
  relay = new FakeRelay();
  session = createHcSession("doriface-final-close");
  const stop = Promise.withResolvers<void>();
  stopped = stop.promise;
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    relay: { url: relay.url },
    log: (line) => {
      if (line.startsWith("relay: uplink stopped")) stop.resolve();
    },
  });
  await relay.answers.next();
}, 30_000);

afterEach(async () => {
  await host.stop();
  await relay.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

async function pairOutput(): Promise<string> {
  const args = ["pair", "--no-qr", "--web-origin", "https://web.example", "--state-dir", stateDir];
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`pair failed: ${stdout}`);
  return stdout;
}

test("after the relay closes the uplink with final 4409, pair reports no relay slot", async () => {
  relay.dropUplink(4409);
  await stopped;
  expect(await pairOutput()).toContain("(no relay slot: pair with the link or QR code)");
}, 30_000);
