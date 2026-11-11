import type { Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { OFFLINE_GRACE_MS } from "../src/workspace/machine-grace.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { stopLines } from "./line-stop.ts";
import { MACHINE_DIALING, MACHINE_ENV, MACHINE_LINE_PID, MACHINE_NAME, MACHINE_SWITCH } from "./machine.ts";
import { readSavedEnv } from "./saved-env.ts";

/** How long a machine's state may lag behind hc: one periodic re-read of machine.list plus slack. */
export const STATE_BOUND_MS = 25_000;

/** How long a machine whose line dropped may read connected before it reads offline: the page's grace (#904), plus as above. */
export const OFFLINE_BOUND_MS = OFFLINE_GRACE_MS + STATE_BOUND_MS;

/** A test that waits a machine out to offline and back: the bound above, plus its setup and its reconnect. */
export const OFFLINE_TEST_TIMEOUT_MS = OFFLINE_BOUND_MS + 120_000;

export const machineRow = (page: Page) => page.getByRole("button", { name: new RegExp(`^${MACHINE_NAME}\\b`) });
export const newOn = (page: Page) => page.getByRole("button", { name: `New space on ${MACHINE_NAME}` });

/** The added machine's state as the e2e core lists it (`hc machine ls`): a layout-free read, the same on every screen. */
export const machineState = (): string => {
  const listed: unknown = JSON.parse(hcOn("host", ["machine", "ls"]));
  const machines = Reflect.get(Object(listed), "machines");
  const one = Array.isArray(machines)
    ? machines.find((m: unknown) => Reflect.get(Object(m), "name") === MACHINE_NAME)
    : undefined;
  return String(Reflect.get(Object(one), "state"));
};

/** Runs hc against the e2e core (`host`) or the added machine's own core (`machine`); returns its stdout. */
export function hcOn(core: "host" | "machine", args: readonly string[], input?: string): string {
  const { hc, env } = readSavedEnv(core === "host" ? E2E_HOST_ENV : MACHINE_ENV);
  const options = { env: { ...process.env, ...env }, encoding: "utf8" } as const;
  return execFileSync(hc, args, input === undefined ? options : { ...options, input });
}

/**
 * Makes the next dial to the machine fail (`off`) or ask for a login (`login`), then stops its core so the open line
 * drops. `drop` refuses the next dial too but only ends the line's process: the machine's core and its terminals keep
 * running, as when the network or doriface-host between the two goes away.
 */
export function switchTo(mode: "off" | "login" | "drop"): void {
  writeFileSync(MACHINE_SWITCH, mode === "login" ? "login" : "off");
  if (mode !== "drop") return void hcOn("machine", ["server", "stop"]);
  stopMachineLines();
}

/**
 * A blip: the machine's lines end, as when a relay uplink drops, and its dials are refused for `refuseMs` (0: none), as
 * a host refuses lines while it settles after its uplink returns. The machine's core and terminals keep running; hc
 * redials by itself. Resolves once the refusal is lifted.
 */
export async function blip(refuseMs: number): Promise<void> {
  if (refuseMs > 0) writeFileSync(MACHINE_SWITCH, "off");
  stopMachineLines();
  if (refuseMs === 0) return;
  await new Promise((resolve) => setTimeout(resolve, refuseMs));
  switchOn();
}

/** The pid of every line dialed to the machine so far, in dial order: every dial that gets past the switch appends one. */
function dialedLines(): number[] {
  return readFileSync(MACHINE_LINE_PID, "utf8")
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

/** Whether `pid` is one of this run's lines and still up: still running hc's `connect` under the second core's session. */
function isLine(pid: number): boolean {
  // Only this run's lines: the dial runs them under the second core's HC_SESSION (`exec env ...`), which `ps e` shows.
  const session = `HC_SESSION=${readSavedEnv(MACHINE_ENV).env["HC_SESSION"] ?? "?"}`;
  const seen = spawnSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  return /\bconnect\b/.test(seen) && seen.includes(session);
}

/** How many lines have been dialed to the machine so far; read before a drop, it marks where hc's redial will land. */
export const linesDialed = (): number => dialedLines().length;

/**
 * Whether a `slow` dial is still on its way: its pid, recorded before it sleeps, still runs the dial's script (which
 * names the switch file). Once it starts its line it runs hc's line instead, and a dial that ended runs nothing.
 */
function isDialing(pid: number): boolean {
  return spawnSync("ps", ["ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(
    MACHINE_SWITCH,
  );
}

/** The pids of the `slow` dials still on their way to the machine. */
function dialsInFlight(): number[] {
  let recorded = "";
  try {
    recorded = readFileSync(MACHINE_DIALING, "utf8");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") throw error;
  }
  return recorded
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 1 && isDialing(pid));
}

/**
 * Whether hc's redial since `dialed` lines (from {@link linesDialed}) has landed: a line dialed after that is up, and no
 * dial is still on its way, so none can get past a later refusal and land after it. hc reads the machine connected all
 * through a drop it redials at once, so its state alone never says the redial landed.
 */
export const redialedSince = (dialed: number): boolean =>
  dialedLines().slice(dialed).some(isLine) && dialsInFlight().length === 0;

function stopMachineLines(): void {
  // hc may hold more than one line, so each one still running hc's `connect` ends. macOS sh execs the line itself; Linux
  // dash keeps a `sh -c` around it, so its children go too. Dead or reused pids are skipped.
  stopLines(dialedLines(), isLine);
}

/**
 * Makes the machine's next dials answer late, as a dial on a loaded runner does: each one gets past the switch at once,
 * then takes 10 s before its line starts. A dial's pid joins the lines' only after that sleep, so `blip` and
 * `stopMachineLines` cannot stop a dial still sleeping; {@link redialedSince} waits it out. `blip` with a refusal and
 * `switchOn` replace the switch, but a dial already past it still lands.
 */
export function slowDials(): void {
  writeFileSync(MACHINE_SWITCH, "slow");
}

/** Lets the machine answer again; hc redials on its own. */
export function switchOn(): void {
  rmSync(MACHINE_SWITCH, { force: true });
}

/** Lets the machine answer and dials it now (`machine.connect`), instead of waiting out hc's redial backoff (up to 30 s). */
export function reconnect(name = MACHINE_NAME): void {
  switchOn();
  const call = { jsonrpc: "2.0", id: 1, method: "machine.connect", params: { machine: name } };
  hcOn("host", ["connect"], `${JSON.stringify(call)}\n`);
}
