import type { Locator, Page } from "@playwright/test";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

interface Geometry {
  readonly fontSize: string;
  readonly rows: number;
  readonly cols: number;
  /** A rendered row's height and a cell's width, in device pixels. */
  readonly rowDevicePx: number;
  readonly cellDevicePx: number;
  readonly firstRowOffsetPx: number;
  readonly scrollLeft: number;
  /** The measured cell and row against the font's own metrics, which no layout or transform can distort. */
  readonly cellMinusAdvance: number;
  readonly rowMinusLineHeight: number;
  readonly transformedAncestors: number;
}

const geometry = (terminal: Locator): Promise<Geometry> =>
  terminal.evaluate((element) => {
    const rows = element.querySelectorAll(".term-row:not(.term-scrollback-row)");
    const first = rows[0]?.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const contentLeft = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const rowStyle = getComputedStyle(rows[0] ?? element);
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("no 2d canvas");
    context.font = `${rowStyle.fontWeight} ${rowStyle.fontSize} ${rowStyle.fontFamily}`;
    const nativeLineHeight =
      Math.round(
        parseFloat(rowStyle.fontSize) * parseFloat(style.getPropertyValue("--term-line-height")) * devicePixelRatio,
      ) / devicePixelRatio;
    // An explicitly sized CSS block truncates to LayoutUnit (1/64px), including a 2/3px native pixel at DPR 1.5.
    const lineHeight = Math.floor(nativeLineHeight * 64) / 64;
    let transformedAncestors = 0;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (getComputedStyle(node).transform !== "none") transformedAncestors += 1;
    }
    return {
      fontSize: style.getPropertyValue("--term-font-size").trim(),
      rows: rows.length,
      cols: rows[rows.length - 1]?.textContent?.length ?? 0,
      rowDevicePx: (first?.height ?? 0) * devicePixelRatio,
      cellDevicePx: parseFloat(style.getPropertyValue("--term-cell-width")) * devicePixelRatio,
      firstRowOffsetPx: Math.abs((first?.left ?? 0) - contentLeft),
      scrollLeft: element.scrollLeft,
      cellMinusAdvance:
        parseFloat(style.getPropertyValue("--term-cell-width")) -
        Math.round(context.measureText("W").width * devicePixelRatio) / devicePixelRatio,
      rowMinusLineHeight: (first?.height ?? 0) - lineHeight,
      transformedAncestors,
    };
  });

async function emulateDpr(page: Page, deviceScaleFactor: number): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("the page has no viewport");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor, mobile: false });
  await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(deviceScaleFactor);
}

function expectFontMetrics(measured: Geometry): void {
  expect(Math.abs(measured.cellMinusAdvance)).toBeLessThan(0.05);
  expect(measured.rowMinusLineHeight).toBe(0);
  expect(measured.transformedAncestors).toBe(0);
}

/**
 * The view has refit to `fontSize` and the core holds the grid it renders. wterm swaps the grid's row elements a frame
 * before it redraws their text, so a single read can pair the new row count with the old column count.
 */
async function settledAt(terminal: Locator, fontSize: string): Promise<Geometry> {
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const settled = async (): Promise<true | string> => {
    const measured = await geometry(terminal);
    return (
      (measured.fontSize === fontSize &&
        Math.abs(measured.cellMinusAdvance) < 0.05 &&
        measured.rowMinusLineHeight === 0 &&
        coreSize(address) === `${measured.rows} ${measured.cols}`) ||
      JSON.stringify({ measured, expectedFontSize: fontSize, core: coreSize(address) })
    );
  };
  await expect.poll(settled, { timeout: 15_000 }).toBe(true);
  return geometry(terminal);
}

async function gridAtCoreSize(terminal: Locator): Promise<string> {
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await expect.poll(async () => coreSize(address) === (await gridSize(terminal)), { timeout: 15_000 }).toBe(true);
  return gridSize(terminal);
}

/** One Cmd/Ctrl + - press, read once the view has refit to `fontSize` and the core holds its grid. */
async function zoomOutTo(page: Page, terminal: Locator, fontSize: string): Promise<Geometry> {
  await pressShortcut(page, "app.zoom_out");
  return settledAt(terminal, fontSize);
}

for (const dpr of [1, 2, 1.5]) {
  test(`zooming out scales the terminal in both directions and refits it, anchored left, at device pixel ratio ${dpr}`, async ({
    page,
  }) => {
    await page.goto("/");
    await emulateDpr(page, dpr);
    const terminal = await openNewTerminal(page);
    const before = await geometry(terminal);
    expectFontMetrics(before);
    const beforeGrid = await gridAtCoreSize(terminal);

    await terminal.getByRole("textbox").focus();
    // Each press is its own zoom level: the cell width and row height follow the font at every one of them. A hinted font
    // can keep one advance across two adjacent sizes, so one press need not add columns; the whole range must.
    let previous = before;
    for (const step of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- each press steps on from the size the previous one left
      const after = await zoomOutTo(page, terminal, `${parseFloat(before.fontSize) - step}pt`);
      expect(after.rows).toBeGreaterThanOrEqual(previous.rows);
      expect(after.cols).toBeGreaterThanOrEqual(previous.cols);
      expect(after.rowDevicePx).toBeLessThanOrEqual(previous.rowDevicePx);
      expect(after.cellDevicePx).toBeLessThanOrEqual(previous.cellDevicePx);
      expectFontMetrics(after);
      expect(after.firstRowOffsetPx).toBeLessThan(0.5);
      expect(after.scrollLeft).toBe(0);
      previous = after;
    }
    expect(previous.rows).toBeGreaterThan(before.rows);
    expect(previous.cols).toBeGreaterThan(before.cols);
    expect(previous.rowDevicePx).toBeLessThan(before.rowDevicePx);
    expect(previous.cellDevicePx).toBeLessThan(before.cellDevicePx);

    await pressShortcut(page, "app.zoom_reset");
    const reset = await settledAt(terminal, before.fontSize);
    expect(`${reset.rows} ${reset.cols}`).toBe(beforeGrid);
  });
}
