import type { Page } from "@playwright/test";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { seedSpaces } from "./layout-doc.ts";
import { expect, test } from "./fixtures.ts";
import { expectTouchTargets, fakeSoftKeyboard, key, keysBar, PHONE } from "./phone-key-bar.ts";

// A touch phone with its soft keyboard down: the keys panel (the one that rides on the keyboard, #2499) sits under the
// terminal, and a press on one of its keys sends it without raising the keyboard (#1526).
test.use({ serviceWorkers: "block", ...PHONE });

const row = keysBar;

async function openDown(page: Page, width: number) {
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return terminal;
}

for (const width of [390, 320]) {
  test(`at ${width}, with the keyboard down, the row's keys reach the program and the keyboard stays down`, async ({
    page,
  }) => {
    const terminal = await openDown(page, width);
    await expect(row(page)).toBeVisible();
    await expect(key(page, "Hide keyboard")).toHaveCount(0);
    await expectTouchTargets(row(page));

    // A press in the terminal takes the focus and raises nothing (#1375); the typed line starts cat -v.
    await terminal.click();
    await page.keyboard.type("cat -v");
    await page.keyboard.press("Enter");
    const input = page.locator("[data-terminal] textarea");
    await expect(input).toBeFocused();

    await row(page).getByRole("button", { name: "Escape", exact: true }).tap();
    await row(page).getByRole("button", { name: "Arrow up", exact: true }).tap();
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("^[^[[A", { timeout: 10_000 });
    await expect(input).toBeFocused();
    await expect(key(page, "Show keyboard")).toBeVisible();
    await expect(key(page, "Hide keyboard")).toHaveCount(0);

    // ^C ends cat: the shell prints its prompt again.
    await row(page).getByRole("button", { name: "Control C", exact: true }).tap();
    await page.keyboard.type("echo back-$((40+2))");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("back-42", { timeout: 10_000 });

    // The terminal fits above the row, and the row inside the screen.
    const [screen, keys] = await Promise.all([terminal.boundingBox(), row(page).boundingBox()]);
    expect(screen).not.toBeNull();
    expect(keys).not.toBeNull();
    if (screen === null || keys === null) return;
    expect(screen.y + screen.height).toBeLessThanOrEqual(keys.y + 1);
    expect(keys.y + keys.height).toBeLessThanOrEqual(844);
  });
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const LOOSE = [
  { width: 390, bottom: 0, right: 0 },
  { width: 320, bottom: 0, right: 0 },
  { width: 390, bottom: 34, right: 0 },
  { width: 390, bottom: 21, right: 47 },
] as const;

for (const { width, bottom, right } of LOOSE) {
  test(`at ${width} with a ${bottom}px bottom and ${right}px right inset and no tabs bar, no key the panel shows sits under Read-only (#1546 review)`, async ({
    page,
  }) => {
    // A shell started after the page loaded is in no tab (loose terminals are adopted on load), so its screen has no
    // tabs bar and Read-only takes a row of its own under the panel.
    const name = `row-loose-${width}-${bottom}-${right}`;
    await fakeSoftKeyboard(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    const shell = startShell("host", name);
    try {
      await page.addStyleTag({ content: `:root:root { --safe-bottom: ${bottom}px; --safe-right: ${right}px; }` });
      await agentRow(page, name, false).click({ timeout: 20_000 });
      await expect(row(page)).toBeVisible({ timeout: 15_000 });
      // An empty layout leaves the open terminal in no tab, whatever adopted it on load.
      seedSpaces([]);
      await expect(page.getByLabel("Tabs in this space")).toHaveCount(0, { timeout: 10_000 });
      const rounds = await Promise.all(
        ["Read-only"].map(async (label) => {
          const box = await key(page, label).boundingBox();
          expect(box, label).not.toBeNull();
          return box as Box;
        }),
      );
      // What a key shows is its box cut to the scrolling row it is in, if any.
      const shown = await row(page).evaluate((bar) => {
        return [...bar.querySelectorAll("button")].flatMap((button) => {
          const edge = (button.closest("[data-slot=terminal-keys-scroll]") ?? bar).getBoundingClientRect();
          const box = button.getBoundingClientRect();
          const x = Math.max(box.left, edge.left);
          const end = Math.min(box.right, edge.right);
          return end - x > 0.5
            ? [{ label: button.getAttribute("aria-label") ?? "", x, y: box.top, width: end - x, height: box.height }]
            : [];
        });
      });
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.filter((each) => rounds.some((round) => overlaps(each, round))).map((each) => each.label)).toEqual(
        [],
      );
      // Read-only sits under the panel: the terminal above keeps its last line clear.
      const [bar, screen] = await Promise.all([row(page).boundingBox(), page.locator("[data-terminal]").boundingBox()]);
      expect(bar).not.toBeNull();
      expect(screen).not.toBeNull();
      if (bar === null || screen === null) return;
      for (const round of rounds) expect(round.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
      expect(screen.y + screen.height).toBeLessThanOrEqual(bar.y + 1);
    } finally {
      endAgent("host", shell);
    }
  });
}

test("the keyboard comes and goes under the same panel, and Read-only hides it", async ({ page }) => {
  await openDown(page, 390);
  await key(page, "Show keyboard").click();
  await expect(key(page, "Hide keyboard")).toBeVisible();
  await expect(row(page)).toHaveCount(1);
  await key(page, "Hide keyboard").click();
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(row(page)).toBeVisible();

  await key(page, "Read-only").click();
  await expect(row(page)).toHaveCount(0);
  await key(page, "Read-only").click();
  await expect(row(page)).toBeVisible();
});
