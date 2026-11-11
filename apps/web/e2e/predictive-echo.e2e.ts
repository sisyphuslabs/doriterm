import type { Locator, Page, TestInfo } from "@playwright/test";
import { gridSize } from "./core-size.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { PHONE, openPhoneTerminal } from "./phone-key-bar.ts";
import { painted, predict, realCell } from "./prediction-probe.ts";
import { installPredictor } from "./prediction-stand-in.ts";

// A key typed over a slow link is drawn at once as a predicted cell over the grid, underlined, in its own layer: the
// terminal's own cells never hold it (design D1, plan S5). Placed by the cursor cell's box, at a phone's 3x pixel ratio
// and on the pinned desktop window, in both themes, for a narrow and a wide cell and on a wrapped line.

const GA = "\u{AC00}";
/** A relay round trip, as the plan's specs inject it. */
const RTT_MS = 300;

type Box = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

/**
 * Within one CSS px on every edge of the real cell's box: where a cell is drawn, not merely that it is. This box check,
 * in all four device and theme configurations and on the wide and wrapped cases, is what the spec proves; a presence
 * check would pass with the overlay drawn in the wrong cell.
 */
function expectSameBox(actual: Box | null | undefined, expected: Box | null | undefined, label: string): void {
  expect(actual, label).toBeTruthy();
  expect(expected, label).toBeTruthy();
  for (const edge of ["left", "top", "width", "height"] as const) {
    expect(
      Math.abs((actual?.[edge] ?? Number.NaN) - (expected?.[edge] ?? Number.NaN)),
      `${label} ${edge}`,
    ).toBeLessThan(1);
  }
}

/** The box of the cell `offset` cells right of `cursor`, `cells` wide. */
const cellAfter = (cursor: Box | null, offset: number, cell: number, cells = 1): Box | null =>
  cursor === null ? null : { ...cursor, left: cursor.left + offset * cell, width: cells * cell };

async function capture(terminal: Locator, info: TestInfo, name: string): Promise<void> {
  await terminal.screenshot({ path: info.outputPath(`${name}.png`) });
}

for (const device of ["desktop", "phone"] as const) {
  for (const colorScheme of ["dark", "light"] as const) {
    test.describe(`${device}, ${colorScheme}`, () => {
      test.use(device === "phone" ? { ...PHONE, colorScheme, serviceWorkers: "block" } : { colorScheme });

      /** A terminal at its prompt with every later host frame held a relay round trip, its keyboard focused. */
      async function open(page: Page): Promise<{ readonly terminal: Locator; readonly link: HcSocket }> {
        const link = await routeHcSocket(page);
        await installPredictor(page);
        let terminal: Locator;
        if (device === "phone") terminal = await openPhoneTerminal(page);
        else {
          await page.goto("/");
          terminal = await openNewTerminal(page);
        }
        link.delay(RTT_MS);
        await terminal.getByRole("textbox").focus();
        return { terminal, link };
      }

      test("a predicted key is drawn underlined in the cursor's cell before its echo, and goes once the echo shows it", async ({
        page,
      }, info) => {
        const { terminal, link } = await open(page);
        const before = await terminal.evaluate(painted);
        const release = link.holdFromHost("");
        const at = await predict(page, "l");
        // Drawn on the next frame or the one after, not a round trip later.
        expect(at.frames).toBeGreaterThan(0);
        expect(at.frames).toBeLessThanOrEqual(2);
        await page.keyboard.type("l");
        const shown = await terminal.evaluate(painted);
        console.log(`predicted ${device} ${colorScheme}: ${JSON.stringify({ before: before.cursor, shown })}`);
        expect(shown.cells).toHaveLength(1);
        expect(shown.cells[0]).toMatchObject({ text: "l", wide: false, underline: "underline" });
        expectSameBox(shown.cells[0], before.cursor, "predicted cell vs the cursor's cell");
        expect(shown.cells[0]?.color).toBe(shown.termColor);
        expect(shown.cells[0]?.background).toBe(shown.termBackground);
        // The real cursor is not drawn; the predicted one sits in the next cell.
        expect(shown.predicting).toBe(true);
        expect(shown.cursor).toMatchObject({ background: "rgba(0, 0, 0, 0)", shadow: "none" });
        expectSameBox(shown.predictedCursor, cellAfter(before.cursor, 1, shown.cell), "predicted cursor");
        // The terminal itself still holds a blank there: the prediction never entered it.
        expect((await realCell(page, at.row, at.col)).trim()).toBe("");
        await capture(terminal, info, `narrow-${device}-${colorScheme}`);

        release();
        await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0);
        await expect.poll(() => realCell(page, at.row, at.col)).toBe("l");
        const after = await terminal.evaluate(painted);
        expect(after.predicting).toBe(false);
        expect(Math.abs((after.cursor?.left ?? 0) - (shown.predictedCursor?.left ?? Number.NaN))).toBeLessThan(1);
      });

      test("a predicted wide syllable covers the two cells its echo takes, at the committed glyph's size", async ({
        page,
      }, info) => {
        const { terminal, link } = await open(page);
        const before = await terminal.evaluate(painted);
        const release = link.holdFromHost("");
        const at = await predict(page, GA, 2);
        expect(at.frames).toBeGreaterThan(0);
        await page.keyboard.insertText(GA);
        const shown = await terminal.evaluate(painted);
        console.log(`predicted wide ${device} ${colorScheme}: ${JSON.stringify(shown.cells)}`);
        expect(shown.cells).toHaveLength(1);
        expect(shown.cells[0]).toMatchObject({ text: GA, wide: true, underline: "underline" });
        expectSameBox(shown.cells[0], cellAfter(before.cursor, 0, shown.cell, 2), "predicted wide cell vs two cells");
        expect((await realCell(page, at.row, at.col)).trim()).toBe("");
        await capture(terminal, info, `wide-${device}-${colorScheme}`);

        release();
        await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0);
        await expect.poll(() => realCell(page, at.row, at.col)).toBe(GA);
        // The core's cell holds the echo before the renderer paints it (one frame later, or later on a loaded runner):
        // the box is read once the echoed glyph is on screen.
        await expect.poll(async () => (await terminal.evaluate(painted)).committedWide).not.toBeNull();
        const committed = (await terminal.evaluate(painted)).committedWide;
        expectSameBox(shown.cells[0], committed, "predicted wide cell vs the echoed glyph");
        expect(shown.cells[0]?.fontSize).toBe(committed?.fontSize);
      });

      test("on a wrapped line a prediction sits at the cursor on the continuation row", async ({ page }, info) => {
        const { terminal, link } = await open(page);
        const cols = Number((await gridSize(terminal)).split(" ")[1]);
        // "$ " and cols + 3 letters wrap the line: the cursor ends on the continuation row, three cells right of the
        // prompt's. Waits for that end position, not the first wrap: readline redraws a wrapping line, moving the cursor
        // meanwhile. The line itself is typed without the injected round trip: only the predicted keys need it.
        link.delay(0);
        await page.keyboard.insertText("x".repeat(cols + 3));
        await expect
          .poll(
            async () => {
              const shown = await terminal.evaluate(painted);
              const first = terminal.locator(".term-row:not(.term-scrollback-row)").first();
              const box = await first.boundingBox();
              const width = (await first.textContent())?.length ?? 0;
              if (shown.cursor === null || box === null || width === 0) return "no cursor";
              // Placed against the grid as it is now, not the prompt's box from before the line was typed: a font that
              // settles late re-fits the grid (a different width, cell and row height) and a phone's keyboard inset
              // scrolls it, and the line wraps at whatever width the grid has. The line is "$ " and cols + 3 letters.
              const line = cols + 5;
              const rows = Math.round((shown.cursor.top - box.y) / shown.cursor.height);
              const col = Math.round((shown.cursor.left - box.x) / shown.cell);
              const want = { rows: Math.floor(line / width), col: line % width };
              return rows === want.rows && col === want.col
                ? "the line's end"
                : `cursor ${rows},${col}, the line ${line} cells at ${width} ends at ${want.rows},${want.col}`;
            },
            { timeout: 15_000 },
          )
          .toBe("the line's end");
        link.delay(RTT_MS);
        const width = Number((await gridSize(terminal)).split(" ")[1]);
        const wrapped = await terminal.evaluate(painted);
        const release = link.holdFromHost("");
        const first = await predict(page, "l");
        await predict(page, "s");
        await page.keyboard.type("ls");
        const shown = await terminal.evaluate(painted);
        console.log(`predicted on a wrapped row ${device} ${colorScheme}: ${JSON.stringify({ cols, shown })}`);
        expect(first.col).toBe((cols + 5) % width);
        expect(shown.cells.map((cell) => cell.text)).toEqual(["l", "s"]);
        expectSameBox(shown.cells[0], wrapped.cursor, "first predicted cell vs the cursor on the continuation row");
        expectSameBox(shown.cells[1], cellAfter(wrapped.cursor, 1, shown.cell), "second predicted cell");
        await capture(terminal, info, `wrapped-${device}-${colorScheme}`);

        release();
        await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0);
        await expect.poll(() => realCell(page, first.row, first.col + 1)).toBe("s");
      });

      test("predictions are hidden while the view is scrolled back, and drawn again at the end", async ({ page }) => {
        const { terminal, link } = await open(page);
        await page.keyboard.type("seq 1 150");
        await page.keyboard.press("Enter");
        await expect(terminal.locator(".term-row").filter({ hasText: /^150 *$/ })).toHaveCount(1, { timeout: 15_000 });
        await expect.poll(() => terminal.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        link.holdFromHost("");
        await predict(page, "l");
        await expect(terminal.locator(".term-prediction-cell")).toHaveCount(1);
        await terminal.evaluate((element) => element.scrollTo({ top: 0 }));
        await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0);
        expect((await terminal.evaluate(painted)).predicting).toBe(false);
        await terminal.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
        await expect(terminal.locator(".term-prediction-cell")).toHaveCount(1);
      });
    });
  }
}
