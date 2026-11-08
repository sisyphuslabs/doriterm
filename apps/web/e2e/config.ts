import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_RUN_ID_ENV, ensureRunPorts } from "./run-ports.ts";

ensureRunPorts();

/** This run's own id: the host a run starts records it, so a host another run started is not this run's to stop (#1412). */
export const E2E_RUN_ID = process.env[E2E_RUN_ID_ENV] ?? "";

/**
 * A port of this run's, from the environment: e2e/run-ports.ts picks free ones per run (#37), so any number of runs on
 * one computer, in one checkout or several, never share one. Nothing here has a port of its own.
 */
function port(name: string): number {
  const value = Number(process.env[name]);
  if (Number.isInteger(value) && value > 0) return value;
  throw new Error(`${name} is not set: run the suite with playwright, whose config picks this run's ports`);
}

/**
 * The Playwright worker slot running this module (0..workers-1, reused when a worker restarts; 0 outside a worker).
 * Each slot has its own e2e host, so workers never share a core.
 */
export const E2E_SLOT = Number(process.env["TEST_PARALLEL_INDEX"] ?? 0) || 0;
/** Slot n's host listens on the base port plus n; the layout host sits below the base. */
export const hostPortOf = (slot: number): number => port("E2E_HOST_PORT") + slot;
/** This worker's e2e host. */
export const E2E_HOST_PORT = hostPortOf(E2E_SLOT);
/** Shared by the e2e host and the specs: the added machine's switch and environment. */
export const E2E_MACHINE_DIR = join(tmpdir(), `doriface-web-e2e-${E2E_HOST_PORT}-machine`);
/** Where the e2e host on `port` saves its core's environment (and its pid) for the specs and the leftover check. */
export const hostEnvOf = (hostPort: number): string => join(tmpdir(), `doriface-web-e2e-${hostPort}-host.json`);
/** This worker's core environment, so a spec can start terminals on it with hc. */
export const E2E_HOST_ENV = hostEnvOf(E2E_HOST_PORT);
export const E2E_WEB_PORT = port("E2E_WEB_PORT");
/** A second e2e host whose names, titles and paths are long, Korean or unbroken, for the layout spec. */
export const E2E_LAYOUT_PORT = port("E2E_LAYOUT_PORT");
/** The layout spec's core environment, so each spec starts with no tabs saved there either. */
export const E2E_LAYOUT_ENV = join(tmpdir(), `doriface-web-e2e-${E2E_LAYOUT_PORT}-host.json`);
/** What the layout host had to stop as it shut down (hc processes it left), for the run's teardown to fail on (#251). */
export const E2E_LAYOUT_LEFT = join(tmpdir(), `doriface-web-e2e-${E2E_LAYOUT_PORT}-left.json`);
/**
 * What the layout host writes as its last step before it exits, so the run's teardown waits for that exit rather than
 * for a wall clock (#1412).
 */
export const E2E_LAYOUT_STOPPED = join(tmpdir(), `doriface-web-e2e-${E2E_LAYOUT_PORT}-stopped.json`);
export const E2E_LAYOUT_MACHINE_DIR = join(tmpdir(), `doriface-web-e2e-${E2E_LAYOUT_PORT}-machine`);
/**
 * The test push services the e2e hosts may post web push notices to (`--push-test-origin`): any port on loopback,
 * since each worker's service binds a free port of its own.
 */
export const E2E_PUSH_ORIGIN = "http://127.0.0.1:0";
/** A throwaway token for a loopback-only test host. */
export const E2E_TOKEN = "doriface-e2e-loopback-token-0000";
