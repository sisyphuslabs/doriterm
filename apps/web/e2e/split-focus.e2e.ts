import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { chordFor } from "./platform-keys.ts";

test.use({ serviceWorkers: "block" });

type Platform = "mac" | "other";
type Move = "right" | "down" | "left" | "up";

/** The split and focus keys `platform` binds (herdr-app's and Ghostty's), as the app's keymap has them. */
const splitKey = (platform: Platform, side: "right" | "down"): string => chordFor(platform, `pane.split:${side}`);
const goKey = (platform: Platform, move: Move): string => chordFor(platform, `pane.go:${move}`);

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const focusedAddress = (page: Page): Promise<string | null> =>
  page.locator('[data-focused="true"] [data-terminal]').getAttribute("data-terminal", { timeout: 15_000 });

const keyboardAddress = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null);

/** Whether the strip's selected tab controls the tab panel that shows the terminal. */
const selectedTabHolds = (page: Page, address: string): Promise<boolean> =>
  page.evaluate((target) => {
    const tab = document.querySelector('[role="tablist"][aria-label="Tabs"] [role="tab"][aria-selected="true"]');
    const panel = document.getElementById(tab?.getAttribute("aria-controls") ?? "");
    return panel?.getAttribute("role") === "tabpanel" && panel.querySelector(`[data-terminal="${target}"]`) !== null;
  }, address);

const paneOf = (page: Page, address: string): Locator =>
  page.locator("section", { has: page.locator(`[data-terminal="${address}"]`) });

/** Whether the selected tab is one the layout document holds, not the first terminal shown alone before it is written. */
const selectedTabWritten = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const tab = document.querySelector('[role="tablist"][aria-label="Tabs"] [role="tab"][aria-selected="true"]');
    const panel = tab?.getAttribute("aria-controls") ?? "";
    return panel !== "" && panel !== "tab-panel-transient" && !panel.startsWith("tab-panel-loose:");
  });

async function boxOf(page: Page, address: string): Promise<Box> {
  const box = await paneOf(page, address).boundingBox();
  if (box === null) throw new Error(`${address} has no box`);
  return box;
}

/** Pane frames still moving (split motion), not the terminals' own animations such as a blinking cursor. */
const paneMotions = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      document.getAnimations().filter((animation) => {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        return (
          animation.playState === "running" &&
          target instanceof Element &&
          target.closest('[role="tabpanel"]') !== null &&
          target.closest(".wterm") === null
        );
      }).length,
  );

async function boxes(page: Page, addresses: readonly string[]): Promise<Record<string, Box>> {
  return Object.fromEntries(await Promise.all(addresses.map(async (address) => [address, await boxOf(page, address)])));
}

const across = (a: number, aLength: number, b: number, bLength: number): boolean => a < b + bLength && b < a + aLength;

/** Right of (or below) `from`: past its far edge, and overlapping it across the other axis. */
function lies(box: Box, from: Box, side: Move): boolean {
  switch (side) {
    case "right":
      return box.x >= from.x + from.width - 1 && across(box.y, box.height, from.y, from.height);
    case "left":
      return box.x + box.width <= from.x + 1 && across(box.y, box.height, from.y, from.height);
    case "down":
      return box.y >= from.y + from.height - 1 && across(box.x, box.width, from.x, from.width);
    case "up":
      return box.y + box.height <= from.y + 1 && across(box.x, box.width, from.x, from.width);
  }
}

/** Each visible terminal's measured cell width: a font metric, the same in every pane whatever its size. */
const cellWidths = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-terminal]")]
      .filter((each) => each.offsetParent !== null)
      .map((each) => (each.querySelector<HTMLElement>(".wterm") ?? each).style.getPropertyValue("--term-cell-width")),
  );

/** Waits until every terminal has settled on the lone terminal's cell width: no pane measured itself mid-animation. */
async function expectCellWidth(page: Page, lone: string): Promise<void> {
  await expect.poll(async () => [...new Set(await cellWidths(page))], { timeout: 10_000 }).toEqual([lone]);
}

/** The terminals whose pane header's buttons reach past its top edge or into its bottom border. */
const overflowingHeaders = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('section[data-split="true"] > header')]
      .filter((header) => {
        const box = header.getBoundingClientRect();
        const inside = box.bottom - Number.parseFloat(getComputedStyle(header).borderBottomWidth);
        return [...header.querySelectorAll("button")].some((button) => {
          const { top, bottom } = button.getBoundingClientRect();
          return top < box.top || bottom > inside;
        });
      })
      .map((header) => header.parentElement?.querySelector("[data-terminal]")?.getAttribute("data-terminal") ?? ""),
  );

/** Presses a split key and returns the new pane once it holds the focus, the keys and the selected tab. */
async function split(page: Page, platform: Platform, side: "right" | "down", from: string): Promise<string> {
  // The tab strip is read once the selected tab is in the document, so ⌘D creating a tab cannot hide behind that write.
  await expect.poll(() => selectedTabWritten(page), { timeout: 15_000 }).toBe(true);
  const strip = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  const tabCount = await strip.count();
  await page.keyboard.press(splitKey(platform, side));
  await expect.poll(() => focusedAddress(page), { timeout: 15_000 }).not.toBe(from);
  const created = await focusedAddress(page);
  if (created === null) throw new Error("no pane is focused after the split");
  await expect(paneOf(page, created)).toContainText("$", { timeout: 15_000 });
  await expect.poll(() => keyboardAddress(page), { timeout: 5_000 }).toBe(created);
  await expect.poll(() => selectedTabHolds(page, created), { timeout: 5_000 }).toBe(true);
  // The split stays in the tab in view: the selected tab holds the pane it came from too.
  await expect.poll(() => selectedTabHolds(page, from), { timeout: 5_000 }).toBe(true);
  await expect(strip).toHaveCount(tabCount);
  expect(lies(await boxOf(page, created), await boxOf(page, from), side)).toBe(true);
  return created;
}

for (const platform of ["mac", "other"] as const) {
  test(`${platform}: four nested splits, right and down, each focus the new pane; moving focus moves no pane`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }),
      platform === "mac" ? "MacIntel" : "Linux x86_64",
    );
    await page.goto("/");
    const first = await openNewTerminal(page);
    const one = (await first.getAttribute("data-terminal")) ?? "";
    await first.getByRole("textbox").focus();
    await expect.poll(async () => (await cellWidths(page))[0] ?? "", { timeout: 10_000 }).not.toBe("");
    const lone = (await cellWidths(page))[0] ?? "";

    const two = await split(page, platform, "right", one);
    const three = await split(page, platform, "down", two);
    const four = await split(page, platform, "right", three);
    const five = await split(page, platform, "down", four);
    // Each pane header holds its 24 px buttons inside its border, so nothing in it spills toward the terminal.
    expect(await overflowingHeaders(page)).toEqual([]);
    await expectCellWidth(page, lone);
    await page.setViewportSize({ width: 820, height: 800 });
    await expectCellWidth(page, lone);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expectCellWidth(page, lone);
    await page.keyboard.type("echo deepest-$((2+3))");
    await page.keyboard.press("Enter");
    await expect(paneOf(page, five)).toContainText("deepest-5", { timeout: 15_000 });
    await expect(paneOf(page, one)).not.toContainText("deepest-5");

    const all = [one, two, three, four, five];
    const placed = await boxes(page, all);
    const steps: readonly [Move, string][] = [
      ["up", four],
      ["left", three],
      ["up", two],
      ["left", one],
      ["right", two],
    ];
    await steps.reduce<Promise<void>>(async (previous, [move, lands]) => {
      await previous;
      await page.keyboard.press(goKey(platform, move));
      await expect.poll(() => focusedAddress(page), { timeout: 5_000 }).toBe(lands);
      await expect.poll(() => keyboardAddress(page), { timeout: 5_000 }).toBe(lands);
      await expect.poll(() => selectedTabHolds(page, lands), { timeout: 5_000 }).toBe(true);
    }, Promise.resolve());
    expect(await boxes(page, all)).toEqual(placed);
  });
}

test("two split keys pressed back to back split the pane the first one makes, as Ghostty does", async ({ page }) => {
  // This case sends the non-Mac chords, whatever platform runs Chromium (#500).
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }));
  await page.goto("/");
  const first = await openNewTerminal(page);
  const one = (await first.getAttribute("data-terminal")) ?? "";
  await first.getByRole("textbox").focus();
  const two = await split(page, "other", "right", one);
  await expect.poll(() => selectedTabWritten(page), { timeout: 15_000 }).toBe(true);
  const before = await boxOf(page, two);

  // No wait between the keys: the second lands while the first one's terminal is still starting.
  await page.keyboard.press(splitKey("other", "right"));
  await page.keyboard.press(splitKey("other", "down"));
  const shown = page.locator('[role="tabpanel"]:not([hidden]) [data-terminal]');
  await expect(shown).toHaveCount(4, { timeout: 15_000 });
  const addresses = await shown.evaluateAll((each) => each.map((node) => node.getAttribute("data-terminal") ?? ""));
  const fresh = addresses.filter((address) => address !== one && address !== two);
  await expect.poll(() => focusedAddress(page), { timeout: 15_000 }).not.toBe(two);
  const last = (await focusedAddress(page)) ?? "";
  const three = fresh.find((address) => address !== last) ?? "";
  expect(fresh).toContain(last);
  await expect.poll(() => keyboardAddress(page), { timeout: 5_000 }).toBe(last);
  // three split off two to the right, and the down key split three, not the pane in focus when it was pressed. Boxes
  // are read once the panes have stopped moving: mid-motion a pane is drawn translated from where it lies.
  await expect.poll(() => paneMotions(page), { timeout: 5_000 }).toBe(0);
  expect(lies(await boxOf(page, three), await boxOf(page, two), "right")).toBe(true);
  expect(lies(await boxOf(page, last), await boxOf(page, three), "down")).toBe(true);
  expect((await boxOf(page, two)).height).toBeCloseTo(before.height, 0);
});
