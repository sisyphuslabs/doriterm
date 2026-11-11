// Two real doriface-hosts, a and b, each with its own hc core, behind the private relay under wrangler dev, for the
// browser spec that reaches a terminal on another machine THROUGH THE MESH (mesh-attach.e2e.ts). `mesh pair` on a and
// `mesh join` on b make the mesh, so b reaches a's core as a machine only through the mesh's own `connect --mesh` line;
// MESH_JOIN=skip leaves them strangers, which the spec must fail on. A shell named `on-b` runs on b's own core.
// Prints `READY {"relayUrl": ..., "machine": ..., "bHostId": ...}` (a's relay, b's machine name on a's core, b's own
// hostId), answers each stdin line with one line: `PAIR` with `LINK <fragment>`, a fresh device pairing link to a; `MESH`
// with `LINK <fragment>`, a fresh mesh invite from a that asks for a code (mesh-join-browser.e2e.ts joins with it);
// `APPROVE <code>` with `APPROVED yes` once a approved the pending join showing that code (else `APPROVED no`, the
// reason on stderr), the inviting person's half of the comparison; `STATUS` with
// `MEMBERS {"meshId": ..., "a": [...], "b": [...]}`, the members each machine's `mesh status --json` lists. `STOP`
// stops b's host process and answers `STOPPED` once a's core lists b as not connected; `START` starts it again on the
// same state (its shell lives on in b's core), dials it from a at once instead of at hc's next redial, and answers
// `STARTED` once a lists it connected. `JOIN`, under MESH_JOIN=skip, joins b to a's mesh then and answers `JOINED <machine>`
// once a lists it connected (relay-two-devices.e2e.ts adds a machine while two devices are open). It stops every process it started on SIGTERM or SIGINT.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRelay } from "../../../apps/host/src/testing/fake-relay.ts";
import { approveOnInviter, browserInviteUrl } from "./compared-browser.ts";
import { startMesh } from "./mesh/mesh.ts";
import { type Member, meshIdOf, statusOf } from "./mesh/status.ts";

const OFFER = /^https:\/\/web\.example\/pair#\S+$/m;
const home = mkdtempSync(join(tmpdir(), "on-b-"));
const fake = process.env["DORIFACE_RELAY_DIR"] === undefined ? new FakeRelay() : undefined;
const mesh = await startMesh({
  names: ["a", "b"],
  coreNames: { a: "studio", b: "build-box" },
  ...(fake === undefined ? {} : { relayUrl: fake.url }),
});
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    try {
      const receipt = await mesh.dispose();
      await fake?.stop();
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

const relayUrl = a.tap?.url ?? fake?.url ?? "";
process.stdout.write(`READY ${JSON.stringify({ relayUrl, machine, bHostId: b.hostId })}\n`);

/** A fresh offer's `#` fragment, from the line the CLI printed for it. */
const fragmentOf = (run: { readonly exit: number; readonly stdout: string; readonly stderr: string }, what: string) => {
  const url = OFFER.exec(run.stdout)?.[0];
  if (run.exit !== 0 || url === undefined) throw new Error(`${what} on a failed: ${run.stderr}${run.stdout}`);
  return new URL(url).hash;
};

const pairingFragment = async (): Promise<string> =>
  fragmentOf(await a.cli("pair", "--no-qr", "--web-origin", "https://web.example", "--relay", relayUrl), "pair");

/** A mesh invite that asks for a code: a browser may join only on one (an --auto invite is for machines). */
const meshFragment = async (): Promise<string> => new URL(await browserInviteUrl(a, relayUrl)).hash;

const approve = async (code: string): Promise<string> => {
  try {
    await approveOnInviter(a, code);
    return "APPROVED yes";
  } catch (error) {
    process.stderr.write(`mesh-hosts: not approved: ${String(error)}\n`);
    return "APPROVED no";
  }
};

/** The members each machine holds, so a spec can prove an admission from the machines' side and not the browser's word. */
const membersOfBoth = async (): Promise<{
  readonly meshId: string;
  readonly a: readonly Member[];
  readonly b: readonly Member[];
}> => ({ meshId: meshIdOf(a), a: (await statusOf(a)).members, b: (await statusOf(b)).members });

const stopB = async (): Promise<string> => {
  await b.stop();
  await mesh.until("b not connected on a's core", async () => (await stateOfB()) !== "connected", 60_000);
  return "STOPPED";
};
const startB = async (): Promise<string> => {
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
  return "STARTED";
};

/** Under MESH_JOIN=skip: b joins a's mesh now, while a spec's pages are open, and is answered once a lists it connected. */
const joinB = async (): Promise<string> => {
  await mesh.join("a", "b");
  await mesh.until("b connected as a machine on a's core", async () => (await machineOfB()) !== undefined, 120_000);
  return `JOINED ${(await machineOfB()) ?? "b"}`;
};

/** Each ask's one answer line, given what follows the ask's first word. */
const answers: Readonly<Record<string, (arg: string) => Promise<string>>> = {
  PAIR: async () => `LINK ${await pairingFragment()}`,
  MESH: async () => `LINK ${await meshFragment()}`,
  APPROVE: approve,
  STATUS: async () => `MEMBERS ${JSON.stringify(await membersOfBoth())}`,
  STOP: stopB,
  START: startB,
  JOIN: joinB,
  STOP_INVITER: async () => {
    await a.stop();
    return "STOPPED inviter";
  },
};

async function answer(ask: string): Promise<void> {
  const [verb = "", ...rest] = ask.split(" ");
  const reply = answers[verb];
  if (reply === undefined) throw new Error(`web-mesh-hosts: unknown line ${ask}`);
  process.stdout.write(`${await reply(rest.join(" "))}\n`);
}

let pending = Promise.resolve();
process.stdin.on("data", (chunk: Buffer) => {
  const asks = chunk
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  pending = asks.reduce((chain, ask) => chain.then(() => answer(ask)), pending);
});
