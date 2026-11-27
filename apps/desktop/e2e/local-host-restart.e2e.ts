// #515: the desktop app runs its own doriface-host for "Use this computer"; when that process dies, the app starts
// another and reconnects to it, and the terminals (still running in hc's core) come back.
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

/** A scratch hc session and a scratch profile, made only when the tests run (not on --list). */
interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly shellHome: string;
  /** While this file exists, a host the app starts waits before it runs (the e2e host wrapper's hold). */
  readonly hold: string;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  // A scratch profile, so the app always starts on first run with nothing saved.
  const profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  // A shell that starts clean: bash without profile or rc files (macOS's /etc/bashrc sets a prompt with
  // the host and user) and a scratch HOME, so the screenshot shows nothing of this machine.
  const shellHome = mkdtempSync(join(tmpdir(), "dd-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o755 });
  const hold = join(shellHome, "hold-host");
  scratch = { hc, profile, shellHome, hold };
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...hc.env,
      // A bare name found on PATH, so the terminal title is "clean-shell" rather than a scratch path.
      SHELL: "clean-shell",
      PATH: `${shellHome}:${process.env["PATH"] ?? ""}`,
      HOME: shellHome,
      PS1: "$ ",
      ENV: "",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
      DORIFACE_E2E_HOST_HOLD: hold,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const args = [`--user-data-dir=${profile}`];
  launched = await electron.launch(await launchOptions(args, { env }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    if (scratch !== undefined) {
      await scratch.hc.dispose();
      rmSync(scratch.profile, { recursive: true, force: true });
      rmSync(scratch.shellHome, { recursive: true, force: true });
    }
  }
});

/** The app's doriface-host: the host CLI among the Electron main process's descendants. */
function localHostPids(main: number): number[] {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), args: match[3] ?? "" }));
  const tree = new Set([main]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (tree.has(row.parent) && !tree.has(row.pid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  return rows
    .filter((row) => tree.has(row.pid) && /apps\/host\/src\/cli\.ts|doriface-host/.test(row.args))
    .map((row) => row.pid);
}

test("when the app's own host dies, a new one starts and the terminal answers again", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  await page.getByRole("button", { name: "Use this computer" }).click();
  await pressNewTab(page, { timeout: 30_000 });
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 30_000 });

  const main = launched.process().pid;
  if (main === undefined) throw new Error("no main process pid");
  const [host] = localHostPids(main);
  if (host === undefined) throw new Error("the app runs no doriface-host");
  process.kill(host, "SIGKILL");

  // A new host, not the dead one, and the page connected to it again. The app restarts its host and reconnects in about
  // a second, inside the 1.5 s a lost link goes unsaid (#2904), so no Reconnecting needs to show; that the link did drop
  // and come back is the note the reattach leaves, that output from the gap may be missing.
  await expect.poll(() => localHostPids(main).filter((pid) => pid !== host).length, { timeout: 30_000 }).toBe(1);
  await expect(
    page.getByRole("status").filter({ hasText: /Output from while disconnected may be missing/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: /Reconnecting/ })).toHaveCount(0, { timeout: 30_000 });
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo host-came-back");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(/host-came-back[\s\S]*host-came-back/, { timeout: 15_000 });
});

test("when the app's own host stays down past 1.5 s, the status bar says Reconnecting until it is back", async () => {
  if (launched === undefined || scratch === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  const main = launched.process().pid;
  if (main === undefined) throw new Error("no main process pid");
  const [host] = localHostPids(main);
  if (host === undefined) throw new Error("the app runs no doriface-host");

  // The new host is held until the notice is seen: an outage past the 1.5 s a lost link goes unsaid is said (#2904).
  writeFileSync(scratch.hold, "");
  process.kill(host, "SIGKILL");
  const reconnecting = page.getByRole("status").filter({ hasText: /Reconnecting/ });
  await expect(reconnecting).toBeVisible({ timeout: 15_000 });
  rmSync(scratch.hold);

  await expect.poll(() => localHostPids(main).filter((pid) => pid !== host).length, { timeout: 30_000 }).toBe(1);
  await expect(reconnecting).toHaveCount(0, { timeout: 30_000 });
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo host-held-came-back");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(/host-held-came-back[\s\S]*host-held-came-back/, { timeout: 15_000 });
});
