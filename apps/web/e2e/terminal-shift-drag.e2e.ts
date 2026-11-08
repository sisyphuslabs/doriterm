import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { reportedRows, reportRowOf, startMouseTracking, stopMouseTracking } from "./mouse-tracking.ts";

test.use({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });

const painted = (page: Page) => page.locator(".term-selection-cells > div");

/** From the second cell of the row that holds `text` to its fifteenth, through its middle. */
async function dragSpan(terminal: Locator, text: string): Promise<{ from: [number, number]; to: [number, number] }> {
  const row = terminal.locator(".term-row").filter({ hasText: text }).first();
  const box = await row.boundingBox();
  if (box === null) throw new Error(`the row holding ${text} has no box`);
  const cell = await terminal.evaluate((el) =>
    parseFloat(getComputedStyle(el.closest(".wterm") ?? el).getPropertyValue("--term-cell-width")),
  );
  const y = box.y + box.height / 2;
  return { from: [box.x + cell * 1.5, y], to: [box.x + cell * 14.5, y] };
}

async function drag(page: Page, span: { from: [number, number]; to: [number, number] }): Promise<void> {
  await page.mouse.move(...span.from);
  await page.mouse.down();
  await page.mouse.move(...span.to, { steps: 6 });
  await page.mouse.up();
}

test("under a program that tracks the mouse, a plain drag is reported to it and selects nothing", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await startMouseTracking(page, terminal);

  const before = (await reportedRows(terminal)).length;
  await drag(page, await dragSpan(terminal, "alpha beta gamma"));
  await expect.poll(() => reportedRows(terminal).then((rows) => rows.length)).toBeGreaterThan(before + 2);
  expect(await reportedRows(terminal)).toContain(await reportRowOf(terminal, "alpha beta gamma"));
  await expect(painted(page)).toHaveCount(0);
  await stopMouseTracking(page);
});

test("under a program that tracks the mouse, Shift and a drag select the text and the program hears nothing", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const input = terminal.getByRole("textbox");
  await input.focus();
  await startMouseTracking(page, terminal);
  await page.evaluate(() => navigator.clipboard.writeText("nothing"));

  await page.keyboard.down("Shift");
  await drag(page, await dragSpan(terminal, "delta epsilon zeta"));
  await page.keyboard.up("Shift");
  await expect.poll(() => painted(page).count()).toBeGreaterThan(0);
  await expect(input).toBeFocused();
  // The held range copies as the Copy action does: Cmd/Ctrl+C with no document selection reads it.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+Shift+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("elta epsilon");

  // A plain drag on another row is reported; it arrives after anything the shift-drag could have sent.
  const before = (await reportedRows(terminal)).length;
  await drag(page, await dragSpan(terminal, "alpha beta gamma"));
  await expect.poll(() => reportedRows(terminal).then((rows) => rows.length)).toBeGreaterThan(before);
  expect(await reportedRows(terminal)).not.toContain(await reportRowOf(terminal, "delta epsilon zeta"));
  await stopMouseTracking(page);
});
