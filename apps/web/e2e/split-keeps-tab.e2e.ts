// A split's terminal starts asynchronously. The person can pick another tab before it answers, and that pick is theirs:
// the split still lands in the tab it was asked for, but it must not select that tab again (#1539). A tab saved while
// the split's terminal starts is no such pick: the person is still on it, and the new pane takes the focus (#2891).
import { startShell } from "./agents.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { clearLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { selectedIndex, tabNumberChord, tabs } from "./tab-strip.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block" });

/** How many terminal.run requests the page has sent. */
const runs = (frames: readonly string[]): number =>
  frames.filter((frame) => frame.includes('"method":"terminal.run"')).length;

test("a split that starts after the person picked another tab leaves that tab selected", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  await openNewTerminal(page);
  await openNewTerminal(page);
  expect(await tabs(page).count()).toBeGreaterThanOrEqual(3);

  const splitAt = await selectedIndex(page);
  const picked = splitAt === 0 ? 1 : 0;
  const before = runs(link.sent());
  // The split's terminal start is held, so the split cannot land until the person has picked another tab.
  const release = link.hold("terminal.run");
  await page.getByRole("button", { name: "Split right" }).click();
  await expect.poll(() => runs(link.sent()), { timeout: 15_000 }).toBe(before + 1);
  await page.keyboard.press(await tabNumberChord(page, picked + 1));
  await expect(tabs(page).nth(picked)).toHaveAttribute("aria-selected", "true");
  const pickedControls = (await tabs(page).nth(picked).getAttribute("aria-controls")) ?? "";
  const pickedTerminal = page.locator(`[id="${pickedControls}"] [data-terminal]`).first();
  await expect(pickedTerminal.getByRole("textbox")).toBeFocused();

  release();
  const controls = (await tabs(page).nth(splitAt).getAttribute("aria-controls")) ?? "";
  // The split's pane lands in its own tab while the pick stays selected.
  await expect(page.locator(`[id="${controls}"] [data-terminal]`)).toHaveCount(2, { timeout: 15_000 });
  await expect(tabs(page).nth(picked)).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page).nth(splitAt)).toHaveAttribute("aria-selected", "false");
  // The terminal in view keeps the keyboard as well (#1704's claim does not reach a tab out of view).
  await expect(pickedTerminal.getByRole("textbox")).toBeFocused();
});

test("a split from a tab saved while its terminal starts focuses the new pane, as the person is still on that tab", async ({
  page,
}) => {
  // With no layout saved, a live terminal shows in a tab of no document until its adoption is saved. The save is held
  // past the split's press and let go before the split's terminal answers, as a loaded core orders them.
  clearLayout();
  const first = startShell("host", "split-saved-meanwhile");
  try {
    const link = await routeHcSocket(page);
    const saves = link.hold("doc.set");
    await page.goto("/");
    await expect(page.locator("#tab-panel-transient")).toBeVisible({ timeout: 20_000 });
    const terminal = page.locator(`[data-terminal="${first}"]`);
    await expect(terminal).toContainText("$", { timeout: 15_000 });
    await terminal.getByRole("textbox").focus();
    const before = runs(link.sent());
    const starts = link.hold("terminal.run");
    await page.getByRole("button", { name: "Split right" }).first().click();
    await expect.poll(() => runs(link.sent()), { timeout: 15_000 }).toBe(before + 1);
    saves();
    await expect(page.locator('[role="tabpanel"]:not(#tab-panel-transient)')).toHaveCount(1, { timeout: 15_000 });
    starts();
    const panes = page.locator("[data-terminal]");
    await expect(panes).toHaveCount(2, { timeout: 15_000 });
    const shown = await panes.evaluateAll((each) => each.map((element) => element.getAttribute("data-terminal")));
    const second = shown.find((address) => address !== first) ?? "";
    // The layout's focused pane is what a pane key, a palette action and the palette's focus return act on.
    await expect(page.locator('[data-focused="true"] [data-terminal]')).toHaveAttribute("data-terminal", second);
  } finally {
    hcOn("host", ["kill", first]);
  }
});
