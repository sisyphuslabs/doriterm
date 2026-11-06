// A host across the network for browser specs, without the private relay: doriface-host on its own scratch core, with
// its uplink on an in-process FakeRelay. The page dials the production relay address (a release build dials no other,
// #389); the spec routes those sockets to this relay's client bridge (relay-route.ts).
//
//   bun e2e/fake-relay-host.ts <web origin> <relay address the page dials>
//
// Prints one `{"stage": <name>, "ms": <n>}` line per startup stage it finishes, then `{"bridge": <url>}` once its uplink
// is answered (and, with --machine, its second core is added), then one `{"link": <pairing link>}` per line read on
// stdin. With --direct it also serves `/v1/e2ee` on a LAN listener and the bridge line carries `directUrl`, the address a
// Direct-address spec sets (#446); no other spec pays for that listener. Stops everything it started on SIGTERM, SIGINT
// or the end of stdin, whichever comes first, as before.
import { startHost } from "@doriface/host";
import { createHcSession, FakeRelay, RelayClientBridge } from "@doriface/host/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { addMachine, DEMO_MACHINE } from "./machine.ts";
import { shellEnv } from "./shell-env.ts";

const started = Date.now();
const say = (line: Readonly<Record<string, unknown>>): void => {
  console.log(JSON.stringify(line));
};
const stage = (name: string): void => {
  say({ stage: name, ms: Date.now() - started });
};

const [webOrigin, relayAddress] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (webOrigin === undefined || !/^https?:\/\//.test(webOrigin) || relayAddress === undefined) {
  console.error("usage: fake-relay-host.ts <web origin> <relay address the page dials>");
  process.exit(2);
}

const CLI = join(import.meta.dir, "..", "..", "host", "src", "cli.ts");
const stateDir = mkdtempSync(join(tmpdir(), "dw-fake-relay-"));
const relay = new FakeRelay();
stage("relay");
const bridge = new RelayClientBridge(relay);
const hc = createHcSession("web-e2e-fake-relay");
stage("session");
const env = { ...hc.env, ...shellEnv(stateDir) };
let host: Awaited<ReturnType<typeof startHost>> | undefined;
let stopMachine: (() => Promise<void>) | undefined;
/** A second machine that joins this host's mesh (#668): its own core and host, on the same fake relay. */
let joiner:
  | {
      readonly host: Awaited<ReturnType<typeof startHost>>;
      readonly hc: ReturnType<typeof createHcSession>;
      readonly dir: string;
    }
  | undefined;

/** What the one-line Add a machine command does on the machine to add, minus the install: its host joins with the link. */
async function joinWith(link: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dw-fake-joiner-"));
  const session = createHcSession("web-e2e-joiner");
  const joinerHost = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: `fake-relay-joiner-${crypto.randomUUID()}`,
    hc: session.hc,
    session: session.name,
    env: { ...session.env, ...shellEnv(dir) },
    stateDir: dir,
    // No uplink: the fake relay keeps one host's uplink at a time, and a second one would take the inviting host's.
    log: () => {},
  });
  joiner = { host: joinerHost, hc: session, dir };
  // The command the installer runs, against this running host. The link names the production relay the page dials;
  // this joiner reaches the inviting host through the bridge instead.
  const args = ["mesh", "join", "--wait-host", "30", "--yes", "--name", "joiner", "--relay", bridge.url];
  const proc = Bun.spawn([process.execPath, CLI, ...args, "--state-dir", dir, link], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`mesh join failed: ${stdout}${stderr}`);
  return "joiner";
}

async function stopAll(): Promise<void> {
  // Every step is tried even when one fails: a stop that throws half way leaves the core it had not reached running.
  const failures: string[] = [];
  const step = async (name: string, stop: () => Promise<void> | undefined): Promise<void> => {
    try {
      await stop();
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  };
  await step("joiner host", () => joiner?.host.stop());
  await step("joiner core", () => joiner?.hc.dispose());
  if (joiner !== undefined) rmSync(joiner.dir, { recursive: true, force: true });
  await step("host", () => host?.stop());
  await step("this core", () => hc.dispose());
  // Stop the dialer before its target: otherwise it can restart the second core during this teardown.
  await step("machine", () => stopMachine?.());
  await step("bridge", () => bridge.stop());
  await step("relay", () => relay.stop());
  rmSync(stateDir, { recursive: true, force: true });
  if (failures.length > 0) console.error(`the fake relay host could not stop everything: ${failures.join("; ")}`);
}

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stopAll();
  process.exit(code);
}
// Before the startup too: a start that is stopped while it runs stops what it already started, as a failed one does.
process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));

async function pairingLink(): Promise<string> {
  const args = ["pair", "--no-qr", "--web-origin", webOrigin ?? "", "--relay", relayAddress ?? ""];
  const proc = Bun.spawn([process.execPath, CLI, ...args, "--state-dir", stateDir], { stdout: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const link = stdout.split("\n").find((line) => line.startsWith(`${webOrigin}/pair#`));
  if ((await proc.exited) !== 0 || link === undefined) throw new Error(`pair failed: ${stdout}`);
  return link;
}

try {
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    // #446: the LAN listener a direct address names; it serves only /v1/e2ee, admitted by the Noise handshake.
    lanListen: { hostname: "127.0.0.1", port: 0 },
    token: `fake-relay-host-${crypto.randomUUID()}`,
    hc: hc.hc,
    session: hc.name,
    env,
    stateDir,
    relay: { url: relay.url },
    log: () => {},
  });
  stage("host");
  await relay.answers.next();
  stage("uplink");
  // With --terminal, the host's core already runs a shell before any device pairs, as a host in use does (#668).
  if (process.argv.includes("--terminal")) {
    const ran = Bun.spawnSync([hc.hc, "run", "--bg", "--name", "existing", "--", "env", "PS1=$ ", "sh"], { env });
    if (ran.exitCode !== 0) throw new Error(`hc run failed: ${ran.stderr.toString()}`);
    stage("terminal");
  }
  // With --machine, the host's core also has an added machine, as a host with more than one computer does.
  if (process.argv.includes("--machine")) {
    stopMachine = await addMachine(hc.hc, env, join(stateDir, "machine"), false, {
      ...DEMO_MACHINE,
      dir: join(stateDir, "machine-files"),
    });
    stage("machine");
  }
  say({
    bridge: bridge.url,
    ...(process.argv.includes("--direct") ? { directUrl: host.e2ee?.lanUrls[0] ?? "" } : {}),
  });
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.startsWith("join ")) say({ joined: await joinWith(line.slice("join ".length)) });
    else say({ link: await pairingLink() });
  }
} catch (error) {
  // A start that fails, or a pairing that does, stops what it started, so no core outlives it, and exits with the
  // reason on stderr (#502, #503).
  console.error(error);
  await shutdown(1);
}
await shutdown(0);
