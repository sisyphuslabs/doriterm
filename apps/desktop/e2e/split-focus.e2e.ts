import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

const mac = process.platform === "darwin";
/** The app's own defaults: Ghostty's and herdr-app's ⌘D / ⌘⇧D, Ctrl+Shift+O / E off macOS. */
const SPLIT = mac ? { right: "Meta+d", down: "Meta+Shift+d" } : { right: "Control+Shift+O", down: "Control+Shift+E" };

let launched: ElectronApplication | undefined;
let cleanup: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  const shellHome = mkdtempSync(join(tmpdir(), "dd-shell-"));
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

const focusedAddress = (page: Page): Promise<string | null> =>
  page.locator('[data-focused="true"] [data-terminal]').getAttribute("data-terminal", { timeout: 15_000 });

const keyboardAddress = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null);

const selectedTabHolds = (page: Page, address: string): Promise<boolean> =>
  page.evaluate((target) => {
    const tab = document.querySelector('[role="tablist"][aria-label="Tabs"] [role="tab"][aria-selected="true"]');
    const panel = document.getElementById(tab?.getAttribute("aria-controls") ?? "");
    return panel?.querySelector(`[data-terminal="${target}"]`) !== null && panel !== null;
  }, address);

/** Whether the selected tab is one the layout document holds, not the first terminal shown alone before it is written. */
const selectedTabWritten = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const tab = document.querySelector('[role="tablist"][aria-label="Tabs"] [role="tab"][aria-selected="true"]');
    const panel = tab?.getAttribute("aria-controls") ?? "";
    return panel !== "" && panel !== "tab-panel-transient" && !panel.startsWith("tab-panel-loose:");
  });

async function boxOf(page: Page, address: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator("section", { has: page.locator(`[data-terminal="${address}"]`) }).boundingBox();
  if (box === null) throw new Error(`${address} has no box`);
  return box;
}

/** Presses a split key and returns the new pane once it holds the focus, the keys and the selected tab. */
async function splitFrom(page: Page, side: "right" | "down", from: string): Promise<string> {
  // The tab strip is read once the selected tab is in the document, so ⌘D creating a tab cannot hide behind that write.
  await expect.poll(() => selectedTabWritten(page), { timeout: 15_000 }).toBe(true);
  const strip = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  const tabCount = await strip.count();
  await page.keyboard.press(SPLIT[side]);
  await expect.poll(() => focusedAddress(page), { timeout: 30_000 }).not.toBe(from);
  const created = (await focusedAddress(page)) ?? "";
  await expect.poll(() => keyboardAddress(page), { timeout: 15_000 }).toBe(created);
  await expect.poll(() => selectedTabHolds(page, created), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => selectedTabHolds(page, from), { timeout: 5_000 }).toBe(true);
  await expect(strip).toHaveCount(tabCount);
  const [box, before] = await Promise.all([boxOf(page, created), boxOf(page, from)]);
  if (side === "right") expect(box.x).toBeGreaterThanOrEqual(before.x + before.width - 1);
  else expect(box.y).toBeGreaterThanOrEqual(before.y + before.height - 1);
  return created;
}

test("in the desktop app, split right and split down focus the new pane beside or below the focused one", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  await page.getByRole("button", { name: "Use this computer" }).click();
  await pressNewTab(page, { timeout: 30_000 });
  const first = page.locator('[data-focused="true"] [data-terminal]');
  await expect(first).toContainText("$", { timeout: 30_000 });
  const one = (await first.getAttribute("data-terminal")) ?? "";
  await first.getByRole("textbox").focus();

  const two = await splitFrom(page, "right", one);
  await splitFrom(page, "down", two);
});
