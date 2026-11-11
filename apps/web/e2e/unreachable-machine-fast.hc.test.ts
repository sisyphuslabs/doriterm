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
 * #2004: a New terminal on an added machine that is not connected must say so at once, not after a link timeout. hc
 * answers `unavailable` from its machine state; measured at 0-6 ms. The bound is 1 s: far above that on a loaded runner,
 * and a tenth of the 10 s a regression to waiting out a link timeout would take. It covers a line that closed: a line
 * left half-open (after a sleep or a network drop), which the core has not noticed yet, is not timed here (#2004).
 */
const FAST_MS = 1_000;

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

test("a New terminal on an added machine that is not connected fails within a second, naming it (#2004)", async () => {
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
      "this-machine",
    );
    const elapsed = performance.now() - startedAt;
    expect(started).toEqual({
      ok: false,
      failure: { machine: spec.name, kind: "unavailable", message: `${spec.name} is not connected` },
    });
    expect(elapsed).toBeLessThan(FAST_MS);
  } finally {
    core.close();
  }
}, 60_000);
