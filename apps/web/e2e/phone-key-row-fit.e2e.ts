import { agentRow, endAgent, startShell } from "./agents.ts";
import { seedSpaces } from "./layout-doc.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { fakeSoftKeyboard, keysBar, PHONE } from "./phone-key-bar.ts";

// The keys under a touch phone's terminal with its keyboard down (#1546, #2499), as the review of #1546 asked (#1555).
test.use({ serviceWorkers: "block", ...PHONE });

test("over the tabs bar the keys panel sits on the bar, the terminal right above it (#2499)", async ({ page }) => {
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
  await expect(page.getByLabel("Tabs in this space")).toBeVisible({ timeout: 15_000 });
  const keys = keysBar(page);
  await expect(keys).toBeVisible();
  const [screen, panel, tabs] = await Promise.all([
    page.locator("[data-terminal]").boundingBox(),
    keys.boundingBox(),
    page.getByLabel("Tabs in this space").boundingBox(),
  ]);
  if (screen === null || panel === null || tabs === null) throw new Error("a box is missing");
  expect(screen.y + screen.height).toBeLessThanOrEqual(panel.y + 1);
  expect(Math.abs(panel.y + panel.height - tabs.y)).toBeLessThanOrEqual(1);
});

test("with no tabs bar the jump button sits at the terminal's corner: the round button is in the row below (#1555)", async ({
  page,
}) => {
  const name = "row-fit-jump";
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  // A shell started after the page loaded is in no tab, and an empty layout keeps it out of one.
  const shell = startShell("host", name);
  try {
    await agentRow(page, name, false).click({ timeout: 20_000 });
    const keys = keysBar(page);
    await expect(keys).toBeVisible({ timeout: 15_000 });
    seedSpaces([]);
    await expect(page.getByLabel("Tabs in this space")).toHaveCount(0, { timeout: 10_000 });
    const terminal = page.locator("[data-terminal]");
    hcOn("host", ["send", "--force", shell, "seq 1 200"]);
    // The typed command already holds "200": wait for the output's last line on a row of its own, so the scroll below
    // happens once the 200 lines are there and the view has something to scroll back through (#2477).
    await expect(terminal.locator(".term-row").filter({ hasText: /^\s*200\s*$/ })).toHaveCount(1, { timeout: 15_000 });
    const viewport = page.locator("[data-slot=terminal-viewport]");
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    const jump = page.getByRole("button", { name: /^Jump to bottom/ });
    await expect(jump).toBeVisible({ timeout: 10_000 });
    const [button, screen, row] = await Promise.all([jump.boundingBox(), terminal.boundingBox(), keys.boundingBox()]);
    if (button === null || screen === null || row === null) throw new Error("a box is missing");
    // Read-only sits under the panel, not over the terminal, so nothing over the terminal needs clearing.
    expect(screen.y + screen.height).toBeLessThanOrEqual(row.y + 1);
    expect(screen.y + screen.height - (button.y + button.height)).toBeLessThan(32);
  } finally {
    endAgent("host", shell);
  }
});
