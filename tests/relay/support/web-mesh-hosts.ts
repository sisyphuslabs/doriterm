// Two real doriface-hosts, a and b, each with its own hc core, behind the private relay under wrangler dev, for the
// browser spec that reaches a terminal on another machine THROUGH THE MESH (mesh-attach.e2e.ts). `mesh pair` on a and
// `mesh join` on b make the mesh, so b reaches a's core as a machine only through the mesh's own `connect --mesh` line;
// MESH_JOIN=skip leaves them strangers, which the spec must fail on. A shell named `on-b` runs on b's own core.
// Prints `READY {"relayUrl": ...}` (a's relay), answers each stdin line `PAIR` with `LINK <fragment>`, a fresh device
// pairing link to a, and stops every process it started on SIGTERM or SIGINT. `STOP` stops b's host process and answers
// `STOPPED` once a's core lists b as not connected; `START` starts it again on the same state (its shell lives on in
// b's core), dials it from a at once instead of at hc's next redial, and answers `STARTED` once a lists it connected.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMesh } from "./mesh/mesh.ts";

const OFFER = /^https:\/\/web\.example\/pair#\S+$/m;
const home = mkdtempSync(join(tmpdir(), "on-b-"));
const mesh = await startMesh({ names: ["a", "b"], coreNames: { a: "studio", b: "build-box" } });
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    try {
      const receipt = await mesh.dispose();
      rmSync(home, { recursive: true, force: true });
      const left = [...receipt.alive.map((own) => `${own.kind} ${own.pid}`), ...receipt.listening.map(String)];
      if (left.length > 0) process.stderr.write(`mesh-hosts: left running: ${left.join(", ")}\n`);
      process.exit(left.length === 0 ? 0 : 1);
    } catch (error) {
      process.stderr.write(`mesh-hosts: stop failed: ${String(error)}\n`);
      process.exit(1);
    }
  })();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const a = mesh.host("a");
const b = mesh.host("b");
const bCore = (await mesh.core("b")).hello.core.id;
const stateOfB = async (): Promise<string | undefined> =>
  (await (await mesh.core("a")).call("machine.list")).machines.find((machine) => machine.id === bCore)?.state;
const machineOfB = async (): Promise<string | undefined> =>
  (await (await mesh.core("a")).call("machine.list")).machines.find(
    (machine) => machine.state === "connected" && machine.id === bCore,
  )?.name;
if (process.env["MESH_JOIN"] !== "skip") {
  await mesh.join("a", "b");
  await mesh.until("b connected as a machine on a's core", async () => (await machineOfB()) !== undefined, 120_000);
}
const machine = (await machineOfB()) ?? "b";

const shell = Bun.spawn([b.session.hc, "run", "--bg", "--name", "on-b", "--cwd", home, "--", "env", "PS1=$ ", "sh"], {
  env: b.session.env,
  stdout: "pipe",
  stderr: "pipe",
});
if ((await shell.exited) !== 0) throw new Error(`hc run on b failed: ${await new Response(shell.stderr).text()}`);

const relayUrl = a.tap?.url ?? "";
process.stdout.write(`READY ${JSON.stringify({ relayUrl, machine })}\n`);

let pending = Promise.resolve();
const pairingFragment = async (): Promise<string> => {
  const offer = await a.cli("pair", "--no-qr", "--web-origin", "https://web.example", "--relay", relayUrl);
  const url = OFFER.exec(offer.stdout)?.[0];
  if (offer.exit !== 0 || url === undefined) throw new Error(`pair on a failed: ${offer.stderr}${offer.stdout}`);
  return new URL(url).hash;
};
const stopB = async (): Promise<void> => {
  await b.stop();
  await mesh.until("b not connected on a's core", async () => (await stateOfB()) !== "connected", 60_000);
  process.stdout.write("STOPPED\n");
};
const startB = async (): Promise<void> => {
  await b.start();
  const aCore = await mesh.core("a");
  await mesh.until(
    "b connected again on a's core",
    async () => {
      if ((await stateOfB()) === "connected") return true;
      // A refused dial is fine: hc records it, and the next turn of this wait dials again.
      await aCore.call("machine.connect", { machine }).catch(() => undefined);
      return (await stateOfB()) === "connected";
    },
    60_000,
  );
  process.stdout.write("STARTED\n");
};
const ASKS: Readonly<Record<string, () => Promise<void>>> = {
  PAIR: async () => void process.stdout.write(`LINK ${await pairingFragment()}\n`),
  STOP: stopB,
  START: startB,
};
process.stdin.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString().split("\n")) {
    const ask = ASKS[line.trim()];
    if (ask !== undefined) pending = pending.then(ask);
  }
});
