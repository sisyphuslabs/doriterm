// herdr-app's close keys and doriface's rename key in the desktop app (#702): Cmd+W closes the tab and Cmd+Shift+W the
// focused pane (Ctrl+Shift+W and Ctrl+Shift+X off macOS), and Cmd+Shift+R (Ctrl+Shift+R) asks for the tab's new name.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

const KEYS =
  process.platform === "darwin"
    ? { closeTab: "Meta+KeyW", closePane: "Meta+Shift+KeyW", rename: "Meta+Shift+KeyR", split: "Meta+d" }
    : {
        closeTab: "Control+Shift+KeyW",
        closePane: "Control+Shift+KeyX",
        rename: "Control+Shift+KeyR",
        split: "Control+Shift+O",
      };

let launched: ElectronApplication | undefined;
let cleanup: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-keys-profile-"));
  const shellHome = mkdtempSync(join(tmpdir(), "dd-keys-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o755 });
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...hc.env,
      SHELL: "clean-shell",
      PATH: `${shellHome}:${process.env["PATH"] ?? ""}`,
      HOME: shellHome,
      PS1: "$ ",
      ENV: "",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  launched = await electron.launch(await launchOptions([`--user-data-dir=${profile}`], { env }));
  cleanup = async () => {
    await hc.dispose();
    rmSync(profile, { recursive: true, force: true });
    rmSync(shellHome, { recursive: true, force: true });
  };
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    await cleanup?.();
  }
});

const strip = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");

const panesInView = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const tab = document.querySelector('[role="tablist"][aria-label="Tabs"] [role="tab"][aria-selected="true"]');
    const panel = document.getElementById(tab?.getAttribute("aria-controls") ?? "");
    return panel?.querySelectorAll("[data-terminal]").length ?? 0;
  });

/** Whether the selected tab is one the layout document holds, so it has a name to change and panes to split. */
const selectedTabWritten = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const tab = document.querySelector('[role="tablist"][aria-label="Tabs"] [role="tab"][aria-selected="true"]');
    const panel = tab?.getAttribute("aria-controls") ?? "";
    return panel !== "" && panel !== "tab-panel-transient" && !panel.startsWith("tab-panel-loose:");
  });

async function focusedTerminal(page: Page): Promise<void> {
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  await expect(focused).toContainText("$", { timeout: 30_000 });
  await focused.getByRole("textbox").focus();
}

test("in the desktop app the rename key asks for the tab's name, and the close keys close the pane, then the tab", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  await page.getByRole("button", { name: "Use this computer" }).click();
  await pressNewTab(page, { timeout: 30_000 });
  await focusedTerminal(page);
  await expect.poll(() => selectedTabWritten(page), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => Reflect.set(window, "sameDocument", true));

  await page.keyboard.press(KEYS.rename);
  const question = page.getByRole("dialog", { name: /^Rename / });
  await expect(question.getByRole("textbox", { name: "Name" })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "sameDocument"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(question).toHaveCount(0);

  await focusedTerminal(page);
  await page.keyboard.press(KEYS.split);
  await expect.poll(() => panesInView(page), { timeout: 30_000 }).toBe(2);
  await focusedTerminal(page);
  await page.keyboard.press(KEYS.closePane);
  await expect.poll(() => panesInView(page), { timeout: 15_000 }).toBe(1);
  await expect(strip(page)).toHaveCount(1);

  await pressNewTab(page, { timeout: 30_000 });
  await expect(strip(page)).toHaveCount(2);
  await focusedTerminal(page);
  await page.keyboard.press(KEYS.closeTab);
  await expect(strip(page)).toHaveCount(1, { timeout: 15_000 });
});
