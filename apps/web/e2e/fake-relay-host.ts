// A host across the network for browser specs, without the private relay: doriface-host on its own scratch core, with
// its uplink on an in-process FakeRelay. The page dials the production relay address (a release build dials no other,
// #389); the spec routes those sockets to this relay's client bridge (relay-route.ts).
//
//   bun e2e/fake-relay-host.ts <web origin> <relay address the page dials>
//
// Prints `{"bridge": <url>}` once the uplink is answered, then one `{"link": <pairing link>}` per line read on stdin.
// Stops everything it started on SIGTERM, SIGINT or the end of stdin.
import { startHost } from "@doriface/host";
import { createHcSession, FakeRelay, RelayClientBridge } from "@doriface/host/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { addMachine, DEMO_MACHINE } from "./machine.ts";
import { shellEnv } from "./shell-env.ts";

const [webOrigin, relayAddress] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (webOrigin === undefined || !/^https?:\/\//.test(webOrigin) || relayAddress === undefined) {
  console.error("usage: fake-relay-host.ts <web origin> <relay address the page dials>");
  process.exit(2);
}

const CLI = join(import.meta.dir, "..", "..", "host", "src", "cli.ts");
const stateDir = mkdtempSync(join(tmpdir(), "dw-fake-relay-"));
const relay = new FakeRelay();
const bridge = new RelayClientBridge(relay);
const hc = createHcSession("web-e2e-fake-relay");
// Match the loopback fixture: the real user's login shell and prompt are not part of a connection test.
const env = { ...hc.env, ...shellEnv(stateDir) };
const host = await startHost({
  listen: { hostname: "127.0.0.1", port: 0 },
  token: `fake-relay-host-${crypto.randomUUID()}`,
  hc: hc.hc,
  session: hc.name,
  env,
  stateDir,
  relay: { url: relay.url },
  log: () => {},
});
await relay.answers.next();
// With --machine, the host's core also has an added machine, as a host with more than one computer does.
const stopMachine = process.argv.includes("--machine")
  ? await addMachine(hc.hc, env, join(stateDir, "machine"), false, {
      ...DEMO_MACHINE,
      dir: join(stateDir, "machine-files"),
    })
  : undefined;

async function pairingLink(): Promise<string> {
  const args = ["pair", "--no-qr", "--web-origin", webOrigin ?? "", "--relay", relayAddress ?? ""];
  const proc = Bun.spawn([process.execPath, CLI, ...args, "--state-dir", stateDir], { stdout: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const link = stdout.split("\n").find((line) => line.startsWith(`${webOrigin}/pair#`));
  if ((await proc.exited) !== 0 || link === undefined) throw new Error(`pair failed: ${stdout}`);
  return link;
}

const done = Promise.withResolvers<void>();
process.once("SIGTERM", () => done.resolve());
process.once("SIGINT", () => done.resolve());
console.log(JSON.stringify({ bridge: bridge.url }));
void (async () => {
  for await (const _ of createInterface({ input: process.stdin }))
    console.log(JSON.stringify({ link: await pairingLink() }));
  done.resolve();
})();
try {
  await done.promise;
} finally {
  await stopMachine?.();
  await host.stop();
  await hc.dispose();
  await bridge.stop();
  await relay.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
process.exit(0);
