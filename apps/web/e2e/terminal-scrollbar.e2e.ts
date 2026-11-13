import type { Locator, Page } from "@playwright/test";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { hcOn } from "./machine-switch.ts";
import { key, keysBar, openPhoneTerminal, PHONE, settledGrid } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const LINES = 3000;

const bar = (terminal: Locator) => terminal.locator("xpath=..").locator("[data-terminal-scrollbar]");
const jump = (terminal: Locator) => terminal.locator("xpath=..").getByRole("button", { name: /^Jump to bottom/ });

interface Measure {
  readonly scrollTop: number;
  readonly max: number;
  readonly rowHeight: number;
  readonly rows: number;
  /** Rows above the screen: the last one is reached at `max`, which padding leaves short of a whole row. */
  readonly scrollback: number;
  readonly track: { readonly top: number; readonly height: number; readonly left: number; readonly right: number };
  readonly thumb: { readonly top: number; readonly height: number; readonly left: number; readonly right: number };
  readonly pane: { readonly right: number; readonly bottom: number };
}

const NO_BOX = { top: Number.NaN, height: Number.NaN, left: Number.NaN, right: Number.NaN };
const boxOf = (rect: { top: number; height: number; left: number; right: number } | null) =>
  rect === null ? NO_BOX : { top: rect.top, height: rect.height, left: rect.left, right: rect.right };

/** The scroll element as the page lays it out, and where the bar and its thumb are drawn over it. */
async function measure(terminal: Locator): Promise<Measure> {
  const read = await terminal.evaluate((element) => {
    const grid = element.querySelectorAll(".term-row:not(.term-scrollback-row)");
    const rowHeight = grid[0]?.getBoundingClientRect().height ?? 0;
    const lane = element.parentElement?.querySelector("[data-terminal-scrollbar]")?.getBoundingClientRect() ?? null;
    const thumb = element.parentElement?.querySelector("[data-scrollbar-thumb]")?.getBoundingClientRect() ?? null;
    const pane = element.getBoundingClientRect();
    const max = element.scrollHeight - element.clientHeight;
    return {
      scrollTop: element.scrollTop,
      max,
      rowHeight,
      rows: grid.length,
      lane: lane === null ? null : lane.toJSON(),
      thumb: thumb === null ? null : thumb.toJSON(),
      pane: { right: pane.right, bottom: pane.bottom },
    };
  });
  return {
    scrollTop: read.scrollTop,
    max: read.max,
    rowHeight: read.rowHeight,
    rows: read.rows,
    scrollback: Math.ceil(read.max / read.rowHeight - 0.001),
    track: boxOf(read.lane),
    thumb: boxOf(read.thumb),
    pane: read.pane,
  };
}

/** The thumb the bar should draw for the view as it is, as herdr-app sizes it: within a pixel of the drawn one. */
function expectThumbMatches(m: Measure): void {
  const total = m.scrollback + m.rows;
  const length = Math.max((m.track.height * m.rows) / total, m.rowHeight);
  const offset = m.max - m.scrollTop < 5 ? m.scrollback : m.scrollTop / m.rowHeight;
  const top = m.track.top + (offset / m.scrollback) * (m.track.height - length);
  expect(m.track.height).toBeCloseTo(m.rows * m.rowHeight, 0);
  expect(Math.abs(m.thumb.height - length)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.thumb.top - top)).toBeLessThanOrEqual(1);
}

/**
 * The view once the bar has drawn it. A scroll re-measures the bar on the next animation frame and React draws it after
 * that, so a measure taken the moment scrollTop lands can still read the thumb where the view was (#335).
 */
async function settled(terminal: Locator): Promise<Measure> {
  let settledView: Measure | undefined;
  await expect(async () => {
    const m = await measure(terminal);
    expectThumbMatches(m);
    settledView = m;
  }).toPass({ timeout: 5_000 });
  if (settledView === undefined) throw new Error("the scrollbar never matched the view");
  return settledView;
}

/** The scrollTop a thumb top (relative to the track) lands on, row by row, as the drag should put it. */
function scrollTopForThumbTop(m: Measure, top: number): number {
  const travel = m.track.height - m.thumb.height;
  const row = Math.round((Math.min(Math.max(top, 0), travel) / travel) * m.scrollback);
  return row >= m.scrollback ? m.max : row * m.rowHeight;
}

/** A terminal at `points` through Settings, wider than the terminal's default so a cell is wider than the lane's 8 px floor. */
async function setFontSize(page: Page, points: number): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page
    .getByRole("tab", { name: "Terminal", exact: true })
    .or(page.getByRole("button", { name: "Terminal", exact: true }))
    .first()
    .click();
  await page.getByRole("textbox", { name: "font-size", exact: true }).fill(String(points));
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Close settings" }).first().click();
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toContainText("$");
}

async function fill(page: Page, terminal: Locator): Promise<void> {
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`seq 1 ${LINES}`);
  await page.keyboard.press("Enter");
  const last = terminal
    .locator(".term-row:not(.term-scrollback-row)")
    .filter({ hasText: new RegExp(`^${LINES}\\s*$`) });
  await expect(last).toHaveCount(1, { timeout: 20_000 });
}

/** Two controls that float over the same corner draw apart, so each takes its own taps. */
async function expectApart(a: Locator, b: Locator): Promise<void> {
  const [one, two] = [await a.boundingBox(), await b.boundingBox()];
  if (one === null || two === null) throw new Error("a control has no box");
  const overlaps =
    one.x < two.x + two.width && two.x < one.x + one.width && one.y < two.y + two.height && two.y < one.y + one.height;
  expect(overlaps).toBe(false);
}

const scrollTo = (terminal: Locator, top: number) =>
  terminal.evaluate((element, to) => {
    element.scrollTop = to;
  }, top);

/**
 * herdr-app's `scrollbar_lane`: from where the grid's text ends to the pane's right edge, or the last 8 px when the text
 * runs closer. Returns how far the drawn lane's left edge is from that, and how wide the room past the text is.
 */
async function laneOffset(terminal: Locator, cols: number): Promise<{ readonly off: number; readonly room: number }> {
  return terminal.evaluate((element, columns) => {
    const style = getComputedStyle(element);
    const pane = element.getBoundingClientRect();
    const cell = parseFloat(element instanceof HTMLElement ? element.style.getPropertyValue("--term-cell-width") : "");
    const textEnd = pane.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + columns * cell;
    const left = Math.max(Math.min(textEnd, pane.right - 8), pane.left);
    const lane = element.parentElement?.querySelector("[data-terminal-scrollbar]")?.getBoundingClientRect();
    return { off: lane === undefined ? Number.NaN : Math.abs(lane.left - left), room: pane.right - textEnd };
  }, cols);
}

test("the bar's lane runs from the end of the text to the edge, as herdr-app's does, at every width across a cell", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openNewTerminal(page);
  // The lane's floor is 8 px: a cell narrower than that leaves no width where the text ends more than 8 px from the
  // edge, so the floor branch would be the only one sampled. 16 pt gives a wider cell on both platforms (#862).
  await setFontSize(page, 16);
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await fill(page, terminal);
  await expect(bar(terminal)).toBeVisible();
  const cell = await terminal.evaluate((element) =>
    parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width")),
  );
  // Widths a cell apart cover every way the columns can fall short of the pane; some leave more than 8 px past the text.
  const widths = Array.from({ length: Math.ceil(cell) + 2 }, (_unused, index) => 1440 + index);
  const widest = await widths.reduce<Promise<number>>(async (previous, width) => {
    const room = await previous;
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(async () => {
        const grid = await gridSize(terminal);
        if (grid !== coreSize(address)) return Number.NaN;
        return (await laneOffset(terminal, Number(grid.split(" ")[1]))).off;
      })
      .toBeLessThanOrEqual(1);
    const cols = Number((await gridSize(terminal)).split(" ")[1]);
    return Math.max(room, (await laneOffset(terminal, cols)).room);
  }, Promise.resolve(0));
  expect(widest).toBeGreaterThan(9);
});

test("at 1440 the scrollbar overlays the padding without reflow, matches the view, and drags and jumps exactly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await expect(bar(terminal)).toHaveCount(0);
  const before = { pty: coreSize(address), grid: await gridSize(terminal) };

  await fill(page, terminal);
  // Scrollback appeared: the grid and the pty keep their size, so nothing reflowed.
  await expect(bar(terminal)).toBeVisible();
  expect(await gridSize(terminal)).toBe(before.grid);
  expect(coreSize(address)).toBe(before.pty);
  // No native scrollbar takes a gutter beside ours: on a platform with classic scrollbars it would cost columns.
  expect(
    await terminal.evaluate((element) =>
      element instanceof HTMLElement ? element.offsetWidth - element.clientWidth : -1,
    ),
  ).toBe(0);

  // At the bottom: the thumb ends the track, there is nothing to jump to, and the bar sits in the right padding.
  let m = await settled(terminal);
  expect(m.thumb.top + m.thumb.height).toBeCloseTo(m.track.top + m.track.height, 0);
  expect(m.track.right).toBeCloseTo(m.pane.right, 0);
  expect(m.thumb.right - m.thumb.left).toBeCloseTo(4, 0);
  await expect(jump(terminal)).toHaveCount(0);

  // The scroll-to-top key: the thumb goes to the top, and the jump button shows, with no new output yet.
  await pressShortcut(page, "terminal.scroll:top");
  await expect.poll(async () => (await measure(terminal)).scrollTop).toBe(0);
  m = await settled(terminal);
  await expect(jump(terminal)).toBeVisible();
  await expect(jump(terminal)).not.toHaveAttribute("data-unread");

  // Output while scrolled up keeps the view where it is and marks the button.
  hcOn("host", ["send", address, "echo fresh-output"]);
  await expect(jump(terminal)).toHaveAttribute("data-unread", "");
  await expect(jump(terminal)).toHaveAccessibleName("Jump to bottom, new output below");
  expect((await measure(terminal)).scrollTop).toBe(0);

  // Dragging the thumb 120 px down lands on the row that thumb top stands for.
  // The mapping below reads the scrollback length, so no output may land between this measure and the drag: the echo
  // above is still followed by its prompt, and one late row moves the landing line by more than a row (#1334). Once the
  // prompt after the echo's output is drawn, the shell has nothing left to print.
  await expect(
    terminal
      .locator(".term-row")
      .filter({ hasText: /^fresh-output\s*$/ })
      .locator("xpath=following-sibling::*[1]"),
  ).toHaveText(/^\$\s*$/);
  m = await settled(terminal);
  const grabX = (m.thumb.left + m.thumb.right) / 2;
  const grabY = m.thumb.top + m.thumb.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX, grabY + 120, { steps: 6 });
  await page.mouse.up();
  const dragged = scrollTopForThumbTop(m, m.thumb.top - m.track.top + 120);
  await expect.poll(async () => Math.abs((await measure(terminal)).scrollTop - dragged)).toBeLessThan(1);
  // A click on the track below the thumb centres the thumb there.
  m = await settled(terminal);
  const clickY = m.track.top + m.track.height * 0.75;
  await page.mouse.click((m.track.left + m.track.right) / 2, clickY);
  const clicked = scrollTopForThumbTop(m, clickY - m.track.top - m.thumb.height / 2);
  await expect.poll(async () => Math.abs((await measure(terminal)).scrollTop - clicked)).toBeLessThan(1);
  // The bar starts no selection and leaves the keyboard with the terminal.
  await expect(terminal.getByRole("textbox")).toBeFocused();

  // The jump button goes back to the live bottom and is gone; output is followed again.
  await jump(terminal).click();
  await expect.poll(async () => (await measure(terminal)).max - (await measure(terminal)).scrollTop).toBeLessThan(5);
  await expect(jump(terminal)).toHaveCount(0);
  await expect(terminal.getByRole("textbox")).toBeFocused();
  hcOn("host", ["send", address, "echo followed-output"]);
  await expect(
    terminal.locator(".term-row:not(.term-scrollback-row)").filter({ hasText: /^followed-output/ }),
  ).toHaveCount(1);
  m = await measure(terminal);
  expect(m.max - m.scrollTop).toBeLessThan(5);

  // Typing anywhere in the scrollback goes back to the bottom.
  await scrollTo(terminal, 0);
  await expect(jump(terminal)).toBeVisible();
  await page.keyboard.type("x");
  await expect.poll(async () => (await measure(terminal)).max - (await measure(terminal)).scrollTop).toBeLessThan(5);
  await page.keyboard.press("Backspace");

  // The alternate screen has no scrollback to show: no bar, no button. Back on the main screen both return.
  await page.keyboard.type(String.raw`printf '\033[?1049h'`);
  await page.keyboard.press("Enter");
  await expect(bar(terminal)).toHaveCount(0);
  await scrollTo(terminal, 0);
  await expect(jump(terminal)).toHaveCount(0);
  await page.keyboard.type(String.raw`printf '\033[?1049l'`);
  await page.keyboard.press("Enter");
  await expect(bar(terminal)).toBeVisible();

  // Under five columns the bar is hidden; given its width back, it shows again.
  await terminal.locator("xpath=..").evaluate((wrapper) => {
    wrapper.style.maxWidth = "40px";
  });
  await expect(bar(terminal)).toHaveCount(0);
  await terminal.locator("xpath=..").evaluate((wrapper) => {
    wrapper.style.maxWidth = "";
  });
  await expect(bar(terminal)).toBeVisible();
});

test.describe("on a phone", () => {
  test.use(PHONE);

  test("at 390 the bar and the jump button work, and the button sits above the key bar", async ({ page }) => {
    const terminal = await openPhoneTerminal(page);
    // The keys raise the keyboard on one animation frame and the terminal draws its new row count on the next: read
    // right after openPhoneTerminal, the grid is still the one from before the keyboard. Measure the settled view.
    await expect(keysBar(page)).toBeVisible();
    await settledGrid(page, terminal);
    const address = (await terminal.getAttribute("data-terminal")) ?? "";
    const before = { pty: coreSize(address), grid: await gridSize(terminal) };
    await fill(page, terminal);
    await expect(keysBar(page)).toBeVisible();
    await expect(bar(terminal)).toBeVisible();
    expect(await gridSize(terminal)).toBe(before.grid);
    expect(coreSize(address)).toBe(before.pty);
    await settled(terminal);

    // A swipe up into the scrollback, as a finger scrolls it.
    await scrollTo(terminal, 0);
    await expect(jump(terminal)).toBeVisible();
    await settled(terminal);
    const button = await jump(terminal).boundingBox();
    const keys = await keysBar(page).boundingBox();
    if (button === null || keys === null) throw new Error("no box for the jump button or the key bar");
    expect(button.y + button.height).toBeLessThanOrEqual(keys.y);
    expect(button.width).toBeGreaterThanOrEqual(44);
    expect(button.height).toBeGreaterThanOrEqual(44);

    // A key from the key bar is typed input too: it goes back to the bottom.
    await key(page, "Arrow keys").click();
    await key(page, "Return").click();
    await expect.poll(async () => (await measure(terminal)).max - (await measure(terminal)).scrollTop).toBeLessThan(5);

    // With the arrow pad open over the keys bar, the button moves up above it, still tappable.
    await scrollTo(terminal, 0);
    await expect(jump(terminal)).toBeVisible();
    await expectApart(jump(terminal), page.getByRole("group", { name: "Arrow keys" }));
    hcOn("host", ["send", address, "echo fresh-output"]);
    await expect(jump(terminal)).toHaveAttribute("data-unread", "");
    await jump(terminal).tap();
    await expect.poll(async () => (await measure(terminal)).max - (await measure(terminal)).scrollTop).toBeLessThan(5);
    await expect(jump(terminal)).toHaveCount(0);

    // With the soft keyboard down the keys sit under the terminal (#2499), and the jump button stays clear of them.
    await key(page, "Hide keyboard").click();
    await expect(key(page, "Hide keyboard")).toHaveCount(0);
    // Growing the pane back fits the grid again, and that fit scrolls a view at the bottom back to the bottom on its
    // own frame: scroll after it, or it takes the scroll back and the jump button never shows.
    await settledGrid(page, terminal);
    await scrollTo(terminal, 0);
    await expect(jump(terminal)).toBeVisible();
    await expectApart(jump(terminal), key(page, "Show keyboard"));
    await jump(terminal).tap();
    await expect(jump(terminal)).toHaveCount(0);
  });
});
