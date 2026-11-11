import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcSession, type HcSession } from "@doriface/host/testing";
import { stopLeftUnder } from "@doriface/host/testing/run-dir";
import { addMachine, DEMO_MACHINE, viaCommand } from "./machine.ts";

let dialer: HcSession | undefined;
let root: string | undefined;

afterEach(async () => {
  await dialer?.dispose();
  if (root !== undefined) {
    await stopLeftUnder(root);
    rmSync(root, { recursive: true, force: true });
  }
  dialer = undefined;
  root = undefined;
});

/** A dial as the dialing core makes one: hc runs the machine's `--via` command with its own connect as the argument. */
async function dialOnce(hc: string, via: string): Promise<number> {
  const line = Bun.spawn(["sh", "-c", `${via} 'exec "${hc}" connect'`], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  line.stdin.write('{"jsonrpc":"2.0","id":0,"method":"hello","params":{}}\n');
  await line.stdin.flush();
  void line.stdin.end();
  return line.exited;
}

test("a dial that reaches an added machine after its stop is refused, so the stop leaves no core behind (#2142)", async () => {
  dialer = createHcSession("machine-late-dial");
  root = mkdtempSync(join(tmpdir(), "dw-machine-"));
  const spec = { ...DEMO_MACHINE, dir: join(root, "files") };
  const stop = await addMachine(dialer.hc, { ...dialer.env }, join(root, "machine"), false, spec);
  const { env: own } = JSON.parse(readFileSync(join(spec.dir, "env.json"), "utf8")) as {
    readonly env: Readonly<Record<string, string>>;
  };
  // The teardown's order (fake-relay-host.ts): the dialing core first, then the machine.
  await dialer.dispose();
  await stop();
  // A line the dialing core started before it stopped can still run after the machine's stop. hc connect starts a core
  // that is not running, so a dial let through here would start the machine's core again, with nothing left to stop it.
  expect(await dialOnce(dialer.hc, viaCommand(own, spec))).not.toBe(0);
  expect(await stopLeftUnder(join(root, "machine"))).toEqual([]);
}, 60_000);
