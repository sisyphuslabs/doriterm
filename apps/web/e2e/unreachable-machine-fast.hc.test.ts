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

/**
 * Whether hc's machine state says the line is down and stays down: `unreachable` (its dial was refused) or
 * `needs_login`. Not "anything but connected": `connecting` is hc redialing, and a run asked then waits on that dial,
 * which may still win (#2389). An absent row is not an answer either.
 */
export const settledOffline = (state: string | undefined): boolean =>
  state === "unreachable" || state === "needs_login";

test("only a refused or login-blocked line counts as down; a redial in progress does not (#2389)", () => {
  expect(settledOffline("unreachable")).toBe(true);
  expect(settledOffline("needs_login")).toBe(true);
  expect(settledOffline("connecting")).toBe(false);
  expect(settledOffline("connected")).toBe(false);
  expect(settledOffline(undefined)).toBe(false);
});

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
    // The core learns the line is gone from its own read of it, a moment after the stop, and redials (`connecting`); a
    // run asked during that redial waits on it. Wait for the core's own state to SETTLE as down (a state, not a delay),
    // then time one New terminal (#2389).
    const state = async (): Promise<string | undefined> =>
      (await core.call("machine.list")).machines.find((machine) => machine.name === spec.name)?.state;
    const settled = async (deadline: number): Promise<string | undefined> => {
      const now = await state();
      if (settledOffline(now) || performance.now() > deadline) return now;
      await Bun.sleep(10);
      return settled(deadline);
    };
    // A dial hc started just before the stop passed its "is the machine there" check already, and its hc connect starts
    // the stopped core again (#2142): the machine reads connected once more. Stop that core too and wait again, a few
    // times at most (#2389).
    const down = async (stops: number): Promise<string | undefined> => {
      const now = await settled(performance.now() + 10_000);
      if (settledOffline(now) || stops === 0) return now;
      await stop();
      return down(stops - 1);
    };
    const last = await down(3);
    if (!settledOffline(last)) throw new Error(`${spec.name} reads ${last ?? "absent"}, not down, after its stop`);
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
