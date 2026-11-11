import type { Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { fractionOf, paneOf, savedTab, seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const shells: string[] = [];
test.afterEach(() => {
  for (const address of shells.splice(0)) hcOn("host", ["kill", address]);
});

const shell = (name: string): string => {
  const address = startShell("host", `move-${name}`);
  shells.push(address);
  return address;
};

/** p1 | p2 | p3, one row, as herdr-app writes ⌘D twice. */
function seedRow(t: readonly string[]): void {
  const [t1 = "", t2 = "", t3 = ""] = t;
  seedLayout([
    {
      id: "tb-move",
      name: "move",
      root: [
        { pane: "p1", terminal: t1 },
        { pane: "p2", terminal: t2 },
        { pane: "p3", terminal: t3 },
      ],
    },
  ]);
}

/** The panes left to right (then top to bottom), by where they are drawn. */
async function drawnOrder(page: Page, addresses: readonly string[]): Promise<string> {
  const boxes = await Promise.all(addresses.map(async (address) => ({ address, at: await fractionOf(page, address) })));
  return boxes
    .toSorted((a, b) => a.at.x - b.at.x || a.at.y - b.at.y)
    .map((each) => each.address)
    .join(" ");
}

const overlay = (page: Page) => page.locator("[data-pane-drop]");

/** Presses a pane's header on its title and moves, in small steps as a hand does, to (fx, fy) of another pane. */
async function grabTo(page: Page, from: string, to: string, fx: number, fy: number): Promise<void> {
  const title = await paneOf(page, from).locator("header h2").boundingBox();
  const target = await paneOf(page, to).boundingBox();
  if (title === null || target === null) throw new Error("no header or target box");
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * fx, target.y + target.height * fy, { steps: 12 });
}

test("a pane dragged by its header lands on another pane's edge or swaps at its centre, Esc cancels, and the layout is saved", async ({
  page,
}) => {
  const t = ["1", "2", "3"].map(shell);
  const [t1 = "", t2 = "", t3 = ""] = t;
  seedRow(t);
  await page.goto("/");
  await expect.poll(() => drawnOrder(page, t), { timeout: 15_000 }).toBe(`${t1} ${t2} ${t3}`);

  // The outer quarter of the target picks its nearest edge: the preview is the half the pane will take.
  await grabTo(page, t1, t3, 0.92, 0.5);
  await expect(overlay(page)).toHaveAttribute("data-pane-drop", "right");
  const [shown, target] = [await overlay(page).boundingBox(), await paneOf(page, t3).boundingBox()];
  if (shown === null || target === null) throw new Error("no preview or target box");
  expect(Math.abs(shown.x - (target.x + target.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(shown.width - target.width / 2)).toBeLessThanOrEqual(2);
  await page.mouse.up();
  await expect(overlay(page)).toHaveCount(0);
  await expect.poll(() => drawnOrder(page, t), { timeout: 15_000 }).toBe(`${t2} ${t3} ${t1}`);
  // herdr-app's move_pane: p1 leaves (its share goes to p2), then splits p3's share with it.
  await expect.poll(() => savedTab("tb-move")).toBe("tb-move(p2@2,p3@0.5,p1@0.5)");
  await expect(paneOf(page, t1)).toHaveAttribute("data-focused", "true");

  // Escape drops nothing: the preview goes, the release writes nothing, every pane stays.
  await grabTo(page, t2, t1, 0.5, 0.5);
  await expect(overlay(page)).toHaveAttribute("data-pane-drop", "swap");
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => drawnOrder(page, t)).toBe(`${t2} ${t3} ${t1}`);
  expect(savedTab("tb-move")).toBe("tb-move(p2@2,p3@0.5,p1@0.5)");

  // The middle swaps the two panes; each place keeps its size.
  await grabTo(page, t2, t1, 0.5, 0.5);
  await page.mouse.up();
  await expect.poll(() => drawnOrder(page, t), { timeout: 15_000 }).toBe(`${t1} ${t3} ${t2}`);
  await expect.poll(() => savedTab("tb-move")).toBe("tb-move(p1@2,p3@0.5,p2@0.5)");
});

test.describe("with clipboard access", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("a drag in the terminal body selects text and moves no pane", async ({ page }) => {
    const t = ["4", "5", "6"].map(shell);
    const [t4 = "", t5 = "", t6 = ""] = t;
    seedRow(t);
    await page.goto("/");
    await expect.poll(() => drawnOrder(page, t), { timeout: 15_000 }).toBe(`${t4} ${t5} ${t6}`);
    const terminal = paneOf(page, t6).locator("[data-terminal]");
    await terminal.getByRole("textbox").focus();
    await page.keyboard.type("echo movesrc-$((6*7))-end");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("movesrc-42-end", { timeout: 15_000 });
    const line = await terminal.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf("movesrc-42-end") ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + "movesrc-42-end".length);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
      }
      return null;
    });
    if (line === null) throw new Error("the output line is not in the terminal");
    // From the line's end back to its start: its start sits on the pane's left edge, beside the line between two panes.
    await page.mouse.move(line.right - 1, line.y);
    await page.mouse.down();
    await page.mouse.move(line.left + 1, line.y, { steps: 8 });
    await expect(overlay(page)).toHaveCount(0);
    await page.mouse.up();
    // The terminal holds the selection and paints its cells, rather than leaving it as the document's selection,
    // which would stop IME composition in its input (#592).
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe("");
    await expect(terminal.locator(".term-selection-cells > div").first()).toBeVisible();
    expect(await drawnOrder(page, t)).toBe(`${t4} ${t5} ${t6}`);
    expect(savedTab("tb-move")).toBe("tb-move(p1,p2,p3)");
  });
});

test("on macOS Cmd+Option+Shift+arrows swap the focused pane with its neighbour, and the palette offers each move", async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const t = ["7", "8", "9"].map(shell);
  const [t7 = "", t8 = "", t9 = ""] = t;
  seedRow(t);
  await page.goto("/");
  await expect.poll(() => drawnOrder(page, t), { timeout: 15_000 }).toBe(`${t7} ${t8} ${t9}`);
  await paneOf(page, t9).locator("[data-terminal]").getByRole("textbox").focus();
  await expect(paneOf(page, t9)).toHaveAttribute("data-focused", "true");

  await pressShortcut(page, "pane.swap:left");
  await expect.poll(() => drawnOrder(page, t), { timeout: 15_000 }).toBe(`${t7} ${t9} ${t8}`);
  await expect.poll(() => savedTab("tb-move")).toBe("tb-move(p1,p3,p2)");
  await expect(paneOf(page, t9)).toHaveAttribute("data-focused", "true");

  await page.getByRole("button", { name: "Command palette" }).first().click();
  const palette = page.getByRole("combobox", { name: "Command", includeHidden: true });
  await palette.fill("Swap pane");
  await Promise.all(
    ["left", "right", "up", "down"].map((direction) =>
      expect(page.getByRole("option", { name: new RegExp(`^Swap pane ${direction}`) })).toBeVisible(),
    ),
  );
});
