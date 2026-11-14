import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { MAC_TITLEBAR_CSS } from "../src/config/window.ts";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

/** A scratch hc session and a scratch profile, made only when the tests run (not on --list). */
interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly shellHome: string;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

// The column test types into the terminal the first test opens.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const hc = scratchHcSession();
  // A scratch profile, so the app always starts on first run with nothing saved.
  const profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  // A shell that starts clean: bash without profile or rc files (macOS's /etc/bashrc sets a prompt with
  // the host and user) and a scratch HOME, so the screenshot shows nothing of this machine.
  const shellHome = mkdtempSync(join(tmpdir(), "dd-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o755 });
  scratch = { hc, profile, shellHome };
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

test("Use this computer attaches a live terminal that echoes", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  await page.getByRole("button", { name: "Use this computer" }).click();
  await pressNewTab(page, { timeout: 30_000 });
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo doriface-ok");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(/doriface-ok[\s\S]*doriface-ok/, { timeout: 15_000 });
  // The session actions name the running program (clean-shell, then bash once it execs); the tab now reads its number.
  // Wait until the program names no path before reading what the window shows.
  await expect(page.getByRole("button", { name: /^Session actions for [^/]+$/ })).toBeVisible({ timeout: 10_000 });
  // The whole window, so the status bar's machine name counts as well as the prompt.
  const shown = (await page.locator("body").textContent()) ?? "";
  const host = hostname().split(".")[0] ?? "";
  expect(host).not.toBe("");
  expect(shown.toLowerCase()).not.toContain(host.toLowerCase());
  expect(shown).not.toContain(userInfo().username);
  if (scratch === undefined) throw new Error("the scratch shell home was not created");
  expect(shown).not.toContain(scratch.shellHome);
  const screenshot = test.info().outputPath("terminal.png");
  await page.screenshot({ path: screenshot });
  console.log(`screenshot ${screenshot}`);
});

test("wide cells and styled runs keep their columns under the app's CSP", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await terminal.getByRole("textbox").focus();
  // Two-column cells (U+AC00 and U+65E5, typed as UTF-8 octal) between runs split by SGR: each run takes its
  // width from its own span style, which the app's CSP must not drop.
  await page.keyboard.type("printf 'ab\\352\\260\\200\\033[1mcd\\033[0m\\346\\227\\245ef\\033[36mgh\\033[0m\\n'");
  await page.keyboard.press("Enter");
  const row = terminal.locator(".term-row").filter({ hasText: /^ab\u{AC00}cd\u{65E5}efgh/u });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const columns = await row.evaluate((element) => {
    const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
    const left = element.getBoundingClientRect().left;
    return Object.fromEntries(
      Array.from(element.children, (span) => [
        span.textContent?.trim() ?? "",
        Math.round((span.getBoundingClientRect().left - left) / cell),
      ]).filter(([text]) => text !== ""),
    );
  });
  expect(columns).toEqual({ ab: 0, "\u{AC00}": 2, cd: 4, "\u{65E5}": 6, ef: 8, gh: 10 });
});

test("under the macOS titlebar rules a whole tab takes the press, so it drags the tab and not the window", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  // Only macOS adds the sheet on its own; adding it here reads the same rules on every platform.
  await launched.evaluate(
    ({ BrowserWindow }, css) => BrowserWindow.getAllWindows()[0]?.webContents.insertCSS(css),
    MAC_TITLEBAR_CSS,
  );
  const regions = await page
    .locator("[data-tab-id]")
    .first()
    .evaluate((pill) => {
      const strip = pill.closest("[data-titlebar]");
      return {
        strip: strip === null ? "" : getComputedStyle(strip).getPropertyValue("-webkit-app-region"),
        pill: getComputedStyle(pill).getPropertyValue("-webkit-app-region"),
      };
    });
  expect(regions).toEqual({ strip: "drag", pill: "no-drag" });
});

test("the mic is live only where the app has the system recognizer: crossed out with why elsewhere (#726)", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  // The mic sits in the tab bar and dictates into the focused pane.
  const mic = page.locator("[data-voice-mic]").first();
  if (process.platform === "darwin") {
    // The packaged Mac app loads its recognizer, so the mic offers dictation. It is not pressed here: that would raise
    // the system's microphone prompt on the runner.
    await expect(mic).toHaveAccessibleName(/^Dictate into /);
    return;
  }
  await expect(mic).toHaveAccessibleName("Dictation unavailable");
  await mic.click();
  const why =
    process.platform === "win32" ? "The Windows app can't dictate yet" : "The desktop app can't dictate here yet";
  await expect(page.getByText(why)).toBeVisible();
  // Nothing asked for the microphone: the strip says why, and Close puts the mic back.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText(why)).toHaveCount(0);
});
