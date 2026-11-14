import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcConnection } from "@doriface/client";
import { createHcSession, type HcSession } from "@doriface/host/testing";
import { stopLeftUnder } from "@doriface/host/testing/run-dir";
import { spawnHcLink } from "../../host/src/mesh/hc-machines.ts";
import { startTerminal } from "../src/workspace/start-on.ts";
import { addMachine, DEMO_MACHINE } from "./machine.ts";

/**
 * #2004: a New terminal on an added machine that is not connected must say so from hc's machine state, not after a wait.
 * The failure itself proves where it came from (`unavailable`, naming the machine); the time rules out the wait. On this
 * path (hc's stdio link) the only wait there is would be hc dialing the absent machine: herdr's 20 s hello probe through
 * the line (apps/host/src/mesh/hc-machines.ts); the client sets no cap of its own, as terminal.run is a waiting call. The bound tells failing fast from
 * that hang: half of it, and about three times the 3.2 s the answer took on a loaded host in two fulls (#2000, #2164),
 * so it measures the product, not the host, as a 1 s budget did not. A line left half-open, which the core has not noticed yet, is not timed here.
 */
const FAST_MS = 10_000;

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

test("a New terminal on an added machine that is not connected fails from its state, not after a wait, naming it (#2004)", async () => {
  dialer = createHcSession("machine-unreachable-fast");
  root = mkdtempSync(join(tmpdir(), "dw-machine-"));
  const spec = { ...DEMO_MACHINE, dir: join(root, "files") };
  const stop = await addMachine(dialer.hc, { ...dialer.env }, join(root, "machine"), false, spec);
  // The machine goes away and its dials are refused from now on: its line drops and cannot come back.
  writeFileSync(join(spec.dir, "switch"), "off");
  await stop();
  const core = await HcConnection.open(spawnHcLink({ hc: dialer.hc, session: dialer.name, env: dialer.env }));
  try {
    // The core learns the line is gone from its own read of it, a moment after the stop; until then a run still starts
    // there. Wait for the core's own machine state to leave "connected" (a state, not a delay), then time one New terminal.
    const gone = async (deadline: number): Promise<void> => {
      const { machines } = await core.call("machine.list");
      const state = machines.find((machine) => machine.name === spec.name)?.state;
      if (state !== "connected") return;
      if (performance.now() > deadline) throw new Error(`${spec.name} still reads connected after its stop`);
      await Bun.sleep(10);
      return gone(deadline);
    };
    await gone(performance.now() + 10_000);
    const startedAt = performance.now();
    const started = await startTerminal(
      (params) => core.call("terminal.run", params),
      { argv: ["true"], on: spec.name },
      { name: "this-machine", shown: () => [] },
    );
    const elapsed = performance.now() - startedAt;
    expect(started).toEqual({
      ok: false,
      failure: { machine: spec.name, kind: "unavailable", message: `${spec.name} is offline` },
    });
    expect(elapsed).toBeLessThan(FAST_MS);
  } finally {
    core.close();
  }
}, 60_000);
