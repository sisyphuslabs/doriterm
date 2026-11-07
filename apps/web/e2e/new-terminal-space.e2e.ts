import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test, pressNewTab } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { machineRow, newOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const focused = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');

/** What `pwd` prints in a terminal, read from its screen. */
async function workingDirectory(page: Page, terminal: Locator): Promise<string> {
  await terminal.click();
  await page.keyboard.type('echo "cwd=$(pwd)"\r');
  await expect(terminal).toContainText(/cwd=\//, { timeout: 15_000 });
  const text = (await terminal.textContent()) ?? "";
  return /cwd=(\/\S*)/.exec(text)?.[1] ?? "";
}

test("New tab starts the shell where the active terminal runs: its machine and its directory", async ({ page }) => {
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
  await newOn(page).click({ force: true });
  const remote = new RegExp(`^${MACHINE_NAME}/t[0-9a-z]+$`);
  await expect(focused(page)).toHaveAttribute("data-terminal", remote, { timeout: 15_000 });
  const first = await focused(page).getAttribute("data-terminal");
  const there = await workingDirectory(page, page.locator(`[data-terminal="${first}"]`));

  await pressNewTab(page.getByRole("button", { name: "New tab" }));
  await expect(focused(page)).not.toHaveAttribute("data-terminal", first ?? "", { timeout: 15_000 });
  await expect(focused(page)).toHaveAttribute("data-terminal", remote);
  const opened = page.locator(`[data-terminal="${await focused(page).getAttribute("data-terminal")}"]`);
  expect(await workingDirectory(page, opened)).toBe(there);
});

test("New tab starts in the directory the active shell has moved to", async ({ page }) => {
  await page.goto("/");
  const first = await openNewTerminal(page);
  await first.click();
  await page.keyboard.type('mkdir -p "${TMPDIR:-/tmp}/f13-moved" && cd "${TMPDIR:-/tmp}/f13-moved"\r');
  await expect(page.getByRole("contentinfo").locator("[data-status-space] [title]")).toHaveText("f13-moved", {
    timeout: 15_000,
  });
  const moved = await workingDirectory(page, first);
  expect(moved).toMatch(/f13-moved$/);
  // The tab bar's New tab, not openNewTerminal's first match, which can be the sidebar's New terminal on this machine.
  const before = await first.getAttribute("data-terminal");
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await expect(focused(page)).not.toHaveAttribute("data-terminal", before ?? "", { timeout: 15_000 });
  const opened = page.locator(`[data-terminal="${await focused(page).getAttribute("data-terminal")}"]`);
  await expect(opened).toContainText("$", { timeout: 15_000 });
  expect(await workingDirectory(page, opened)).toBe(moved);
});
