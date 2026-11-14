import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

let hc: ReturnType<typeof scratchHcSession> | undefined;
let profile: string | undefined;
let shellHome: string | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  hc = scratchHcSession();
  // A scratch profile, so the app starts on its first run with nothing saved.
  profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  shellHome = mkdtempSync(join(tmpdir(), "dd-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/sh -i\n", { mode: 0o755 });
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...hc.env,
      SHELL: "clean-shell",
      PATH: `${shellHome}:${process.env["PATH"] ?? ""}`,
      HOME: shellHome,
      PS1: "$ ",
      ENV: "",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  launched = await electron.launch(await launchOptions([`--user-data-dir=${profile}`], { env }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    await hc?.dispose();
    if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
    if (shellHome !== undefined) rmSync(shellHome, { recursive: true, force: true });
  }
});

test("a first launch while the OS reports no network still offers Use this computer, and it opens a terminal", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  // Wi-Fi off before anything is configured: this computer's host needs no network.
  await launched
    .context()
    .addInitScript(() =>
      Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false }),
    );
  await page.reload();
  const use = page.getByRole("button", { name: "Use this computer" });
  await expect(use).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("You are offline")).toHaveCount(0);
  // Pairing is the one network step: offered, but disabled, and it says why.
  const pair = page.getByRole("button", { name: "Pair a host" });
  await expect(pair).toBeDisabled();
  await expect(pair).toHaveAccessibleDescription("Pairing a host needs a network.");
  await use.click();
  await pressNewTab(page, { timeout: 30_000 });
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo offline-$((6*7))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("offline-42", { timeout: 15_000 });
  await expect(page.getByText("You are offline")).toHaveCount(0);
});
