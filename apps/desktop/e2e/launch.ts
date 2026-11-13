import type { Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { RUN_DIR } from "./run-dir.ts";

export const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** CI points this at the electron-builder --dir output so the packaged app is what launches. */
export const packagedExecutable = process.env["DORIFACE_E2E_EXECUTABLE"];

const hideWindows = join(appDir, "e2e", "hide-windows.cjs");

/**
 * Linux e2e runs draw on xvfb, which has no GPU. Without --disable-gpu the GPU process first brings up Mesa's GL
 * (ANGLE over GLX, loading libLLVM and libgallium) only to end up compositing in software anyway. No frame can be
 * composited until that is done, so neither ready-to-show nor a page.screenshot capture can happen; on a cold CI runner
 * that took from seconds to over 30 s (#80).
 */
const platformArgs: readonly string[] = process.platform === "linux" ? ["--disable-gpu"] : [];

/**
 * The command-line arguments every e2e launch passes, followed by `extra`: from this checkout they start the app with
 * every window hidden (Electron's -r loads the hook before the app); a packaged executable cannot load the hook.
 */
export function appArgs(extra: readonly string[] = [], { gpu = false } = {}): string[] {
  const args = [...(gpu ? [] : platformArgs), ...extra];
  return packagedExecutable === undefined ? ["-r", hideWindows, appDir, ...args] : args;
}

const attachAfterFirstLoad = join(appDir, "e2e", "attach-after-first-load.ts");
const HOST_CLI = join(appDir, "..", "host", "src", "cli.ts");
const HOST_RIG = join(appDir, "e2e", "host-rig.ts");
const HOST_WRAPPER = join(RUN_DIR, "host-wrapper", "host.ts");
const HOST_RECORDS = join(RUN_DIR, "host-wrapper", "records.jsonl");

/**
 * The host the wrapper starts: the one bundled beside the packaged app in a packaged run, so the packaged CI job and
 * the release AppImage step keep testing the host binary that ships; the checkout's source host otherwise.
 */
function hostCliForRun(): string {
  const executable = process.env["DORIFACE_E2E_EXECUTABLE"];
  if (executable === undefined || executable === "") return HOST_CLI;
  return join(
    dirname(executable),
    "resources",
    "bin",
    process.platform === "win32" ? "doriface-host.exe" : "doriface-host",
  );
}

interface HostRigAnswer {
  readonly relay: string;
  readonly hostCli: string;
  readonly wrapper: string;
  readonly records: string;
}

interface HostRig {
  /** What an app launch's env needs to run its host on the rig's relay: the wrapper as the host binary. */
  readonly env: Record<string, string>;
  stop(): Promise<void>;
}

let hostRig: Promise<HostRig> | undefined;

/** The stand-in relay and the guard wrapper for the ordinary launches, in their own Bun process (the runner is Node). */
function startHostRig(): Promise<HostRig> {
  const child = spawn(process.env["BUN_BIN"] ?? "bun", [HOST_RIG, hostCliForRun(), HOST_WRAPPER, HOST_RECORDS], {
    cwd: appDir,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const answer = new Promise<HostRigAnswer>((resolve, reject) => {
    lines.once("line", (line) => {
      try {
        resolve(JSON.parse(line) as HostRigAnswer);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("exit", (code) => reject(new Error(`the host rig exited (code ${String(code)})`)));
  });
  return answer.then((rig) => ({
    env: {
      DORIFACE_HOST_BIN: rig.wrapper,
      DORIFACE_E2E_RELAY: rig.relay,
      DORIFACE_E2E_HOST_RECORDS: rig.records,
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.stdin?.end();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  }));
}

/**
 * The environment every e2e app launch takes (#2399): the app's host starts on a relay this run owns, never the
 * release relay, so a launch cannot open a Room on the production relay. Entries already set (a pairing rig's own
 * wrapper, or a spec's own host CLI) are kept. The one opt-out is the production smoke itself, in its own env:
 * `DORIFACE_E2E_RELAY_GUARD=off` passes that launch through untouched - never a runner-wide variable.
 */
export async function guardedEnv(env: Record<string, string> = {}): Promise<Record<string, string>> {
  if (env["DORIFACE_E2E_RELAY_GUARD"] === "off") return env;
  const rig = await (hostRig ??= startHostRig());
  const guarded = { ...env };
  for (const [key, value] of Object.entries(rig.env)) {
    if (guarded[key] === undefined || guarded[key] === "") guarded[key] = value;
  }
  if (guarded["DORIFACE_E2E_HOST_CLI"] === undefined || guarded["DORIFACE_E2E_HOST_CLI"] === "") {
    guarded["DORIFACE_E2E_HOST_CLI"] = hostCliForRun();
  }
  return guarded;
}

/** Stops this process's stand-in relay, if it started one; the specs never need this (it dies with the runner). */
export async function stopHostRig(): Promise<void> {
  const started = hostRig;
  hostRig = undefined;
  if (started === undefined) return;
  try {
    await (await started).stop();
  } catch {
    // The rig was already gone.
  }
}

/**
 * What every electron.launch() takes. The packaged app always starts through attach-after-first-load: attached
 * directly, Playwright can land while the first navigation is in flight and then waits forever (#13). `env` defaults
 * to the filtered `process.env`, so a launch that passes no env of its own is still guarded (#2399): every launch's
 * host starts on a relay this run owns, never the release relay.
 */
export async function launchOptions(
  extra: readonly string[] = [],
  { env, gpu = false }: { env?: Record<string, string>; gpu?: boolean } = {},
): Promise<
  | { readonly args: string[]; readonly env: Record<string, string> }
  | {
      readonly executablePath: string;
      readonly args: string[];
      readonly env: Record<string, string>;
    }
> {
  const args = appArgs(extra, { gpu });
  const guarded = await guardedEnv(
    env ??
      Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
  );
  return packagedExecutable === undefined
    ? { args, env: guarded }
    : { executablePath: attachAfterFirstLoad, args, env: guarded };
}

/** Opens a terminal through the strip's New tab menu, or the empty workspace's direct New terminal button. */
export async function pressNewTab(page: Page, options: { readonly timeout?: number } = {}): Promise<void> {
  const button = page
    .getByRole("button", { name: "New tab" })
    .or(page.getByRole("button", { name: "New terminal" }))
    .first();
  await button.click(options);
  if ((await button.getAttribute("aria-haspopup")) === "menu") {
    await page.getByRole("menuitem", { name: /^Terminal/ }).click(options);
  }
}
