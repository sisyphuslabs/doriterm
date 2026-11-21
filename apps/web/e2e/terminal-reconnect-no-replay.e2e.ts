import type { Locator, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, laidOutBox, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";

test.use({ serviceWorkers: "block" });

const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

const LAST = 4000;
/** The window title the shell sets once it has printed the last line: every line has reached the page. */
const FLOOD_END = "no-replay-flood-end";
/**
 * Lines whose last 2,100 carry two dozen colors each: a 2,000-line history replay of them is over a MiB, which a slow
 * link takes many seconds to hand over, while the lines before them stay plain and quick to print.
 */
const COLORED_FLOOD = `c=$(for k in $(seq 1 24); do printf '\\033[38;5;%d;48;5;%dmx' $((k*9)) $((255-k*9)); done); for i in $(seq 1 ${LAST}); do if [ $i -gt ${LAST - 2100} ]; then echo "line-$i $c"; else echo line-$i; fi; done; printf '\\033[0m\\033]2;${FLOOD_END}\\007'`;
/** A link this slow hands a 2,000-line replay of the flood over in about ten seconds, a 256 KiB window in almost two. */
const SLOW_LINK_BYTES_PER_SECOND = 150_000;
/** One credit window of a stream: a screen's repaint is far less, the history's replay far more. */
const CREDIT_WINDOW_BYTES = 256 * 1024;

interface Sample {
  /** The highest `line-N` on the terminal's screen rows, 0 when none. */
  readonly last: number;
  /** How far the view is above its end, in px. */
  readonly fromEnd: number;
}

/** Samples, every animation frame, what the terminal's screen shows and where its view is. */
async function startSampler(terminal: Locator): Promise<void> {
  await terminal.evaluate((element) => {
    const samples: Sample[] = [];
    let on = true;
    const sample = (): void => {
      let last = 0;
      for (const row of element.querySelectorAll(".term-grid .term-row:not(.term-scrollback-row)"))
        for (const match of (row.textContent ?? "").matchAll(/line-(\d+)/g)) last = Math.max(last, Number(match[1]));
      samples.push({ last, fromEnd: element.scrollHeight - element.clientHeight - element.scrollTop });
      if (on) requestAnimationFrame(sample);
    };
    Reflect.set(window, "__stopSampler", () => {
      on = false;
      return samples;
    });
    requestAnimationFrame(sample);
  });
}

const stopSampler = (page: Page): Promise<Sample[]> =>
  page.evaluate(() => (Reflect.get(window, "__stopSampler") as () => Sample[])());

/** Rows of history above the screen, from the scroller's height: the scrollback renders only the rows in view. */
const historyRows = (terminal: Locator, rowHeight: number): Promise<number> =>
  terminal.evaluate((element, height) => Math.round((element.scrollHeight - element.clientHeight) / height), rowHeight);

/**
 * The oldest line the history holds: the first row that starts `line-N` once the view is at its top (the command that
 * printed them may be above it). The history's rows in view render on the next frame, and until then a spacer stands at
 * the top with the screen's rows below it: the rows are read only once one covers the view's top edge. Leaves the view
 * at its end.
 */
async function oldestLine(terminal: Locator): Promise<number> {
  await terminal.evaluate((element) => {
    element.scrollTop = 0;
  });
  const first = (): Promise<number> =>
    terminal.evaluate((element) => {
      const top =
        element.getBoundingClientRect().top +
        element.clientTop +
        Number.parseFloat(getComputedStyle(element).paddingTop);
      const rows = [...element.querySelectorAll(".term-grid .term-row")].filter(
        (row) => row.getBoundingClientRect().bottom > top,
      );
      if (!rows.some((row) => row.getBoundingClientRect().top <= top + 0.5)) return 0;
      const line = rows.map((row) => /^line-(\d+)/.exec(row.textContent ?? "")).find((match) => match !== null);
      return Number(line?.[1] ?? 0);
    });
  await expect.poll(first).toBeGreaterThan(0);
  const oldest = await first();
  await terminal.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => terminal.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThan(1);
  return oldest;
}

/**
 * How many times each `line-N` shows in the history and on the screen, read half a view at a time from the top: the
 * history renders only the rows in view. Rows are keyed by their place, so a row read twice counts once. Leaves the
 * view at its end.
 */
async function lineCounts(terminal: Locator, rowHeight: number): Promise<Map<number, number>> {
  const rows = new Map<number, string>();
  const { height, view } = await terminal.evaluate((element) => ({
    height: element.scrollHeight,
    view: element.clientHeight,
  }));
  const inView = (): Promise<(readonly [number, string])[]> =>
    terminal.evaluate((element, rowPx) => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll(".term-grid .term-row")].flatMap((row) => {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= box.top || rect.top >= box.bottom) return [];
        return [[Math.round((rect.top - box.top + element.scrollTop) / rowPx), row.textContent ?? ""] as const];
      });
    }, rowHeight);
  const tops = Array.from({ length: Math.ceil(height / (view / 2)) }, (_unused, index) => (index * view) / 2);
  await tops.reduce<Promise<void>>(async (previous, top) => {
    await previous;
    await terminal.evaluate((element, y) => {
      element.scrollTop = y;
    }, top);
    // The rows in view render on the next frame: read them once the whole view has its rows.
    await expect.poll(async () => (await inView()).length).toBeGreaterThanOrEqual(Math.floor(view / rowHeight));
    for (const [at, text] of await inView()) rows.set(at, text);
  }, Promise.resolve());
  await terminal.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const counts = new Map<number, number>();
  for (const text of rows.values()) {
    const line = /^line-(\d+)[\s\u00a0]*$/u.exec(text);
    if (line) counts.set(Number(line[1]), (counts.get(Number(line[1])) ?? 0) + 1);
  }
  return counts;
}

const attachCount = (page: Page): Promise<number> =>
  page.evaluate(() => (Reflect.get(window, "__dorifaceAttachLog") as unknown[]).length);

/** Drops the link and lets the page connect again: the view has asked to attach once more when this returns. */
async function dropAndReconnect(page: Page, link: HcSocket): Promise<void> {
  const before = link.opened();
  const attaches = await attachCount(page);
  await link.drop(true);
  link.restore();
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect.poll(() => attachCount(page)).toBeGreaterThan(attaches);
}

/** Opens a terminal whose shell has printed `lines` lines, with the attach log on. */
async function openWithHistory(page: Page, lines: number, setup = ""): Promise<Locator> {
  await page.addInitScript(() => {
    Reflect.set(window, "__dorifaceAttachLog", []);
  });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  opened.push((await terminal.getAttribute("data-terminal")) ?? "");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`${setup}for i in $(seq 1 ${lines}); do echo line-$i; done`);
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(`line-${lines}`, { timeout: 30_000 });
  return terminal;
}

/**
 * A reconnect redraws the screen and keeps the history the view already holds (#1997). It used to ask for 2,000 lines of
 * history and wipe its own first, so the history played again: over a slow link the replay outlasted the paint hold
 * and the view climbed through it, from its oldest line to its end, for seconds.
 */
test("a reconnect over a slow link redraws the screen without playing the history again (#1997)", async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    Reflect.set(window, "__dorifaceAttachLog", []);
  });
  let counting = false;
  let reattachBytes = 0;
  const link = await routeHcSocket(page, {
    received: (frame) => {
      if (counting) reattachBytes += frame.length;
    },
  });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  opened.push((await terminal.getAttribute("data-terminal")) ?? "");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(COLORED_FLOOD);
  await page.keyboard.press("Enter");
  await expect(terminal).toHaveAttribute("aria-label", `${FLOOD_END} output`, { timeout: 60_000 });
  await expect(terminal).toContainText(`line-${LAST}`, { timeout: 60_000 });
  const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());
  expect(row.height).toBeGreaterThan(0);
  const oldestBefore = await oldestLine(terminal);
  const historyBefore = await historyRows(terminal, row.height);

  await startSampler(terminal);
  link.delay(150);
  link.throttle(SLOW_LINK_BYTES_PER_SECOND);
  counting = true;
  await dropAndReconnect(page, link);
  // Output after the reattach comes behind its paint on the same stream: once it shows, the paint has been drawn.
  await page.keyboard.type("echo done-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("done-2", { timeout: 60_000 });
  const frames = await stopSampler(page);

  expect(frames.length).toBeGreaterThan(0);
  // No frame shows an older line on the screen, and the view never leaves its end: nothing plays again.
  expect(frames.filter((frame) => frame.last !== LAST)).toEqual([]);
  expect(Math.max(...frames.map((frame) => frame.fromEnd))).toBeLessThan(row.height * 2);
  // The history is still all there, and the screen redrawn over itself is not added to it: it grew only by the lines
  // the command and its prompt pushed up (a screen's rows more would be the old screen kept twice).
  const grown = (await historyRows(terminal, row.height)) - historyBefore;
  expect(grown).toBeGreaterThanOrEqual(0);
  expect(grown).toBeLessThan(6);
  expect(await oldestLine(terminal)).toBe(oldestBefore);
  // The reattach sent the screen, not the history: far less than one credit window, where the replay was over a MiB.
  expect(reattachBytes).toBeLessThan(CREDIT_WINDOW_BYTES);
});

/**
 * A shell that marks its prompt (OSC 133, as fish 4 and the shell-integration scripts do) has Ghostty scroll the screen
 * into history on an ESC[2J over it, and the core's repaint starts with one: unless the view clears its screen first,
 * every reconnect keeps the old screen in the history a second time.
 */
test("a reconnect under a marked prompt does not add the old screen to the history (#1997)", async ({ page }) => {
  const link = await routeHcSocket(page);
  const terminal = await openWithHistory(page, 200, `PS1="$(printf '\\033]133;A\\007')marked$ "; `);
  await expect(terminal).toContainText("marked$");
  const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());
  const historyBefore = await historyRows(terminal, row.height);

  await dropAndReconnect(page, link);
  await page.keyboard.type("echo done-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("done-2", { timeout: 30_000 });

  // The command and its prompt push up two rows; the old screen kept again would be a screen's rows more.
  const grown = (await historyRows(terminal, row.height)) - historyBefore;
  expect(grown).toBeGreaterThanOrEqual(0);
  expect(grown).toBeLessThan(6);
});

/** The text on the terminal's screen rows, without its history. */
const screenText = (terminal: Locator): Promise<string> =>
  terminal.evaluate((element) =>
    [...element.querySelectorAll(".term-grid .term-row:not(.term-scrollback-row)")]
      .map((row) => row.textContent ?? "")
      .join("\n"),
  );

/**
 * A full-screen program (vim, less, htop) draws on the alternate screen and keeps the prompt screen behind it. The core's
 * repaint leaves the alternate screen and starts with ESC[2J on the primary one, which over the marked prompt scrolls that
 * screen into history. herdr-core before 0.1.21 does not draw the primary screen again, so the history is then the only
 * place that output is and the view must not erase the primary screen first; from 0.1.21 the repaint draws it again, so
 * the view clears it too, or it would be kept twice (#2514, reattach-clear.ts). This test runs the path of the core CI
 * pins (.github/workflows/ci.yml); reattach-clear.test.ts covers the clear the view writes for either core.
 */
test("a reconnect under a full-screen program keeps the output behind it, once (#1997)", async ({ page }) => {
  const link = await routeHcSocket(page);
  const terminal = await openWithHistory(page, 200, `PS1="$(printf '\\033]133;A\\007')marked$ "; `);
  await expect(terminal).toContainText("marked$");
  const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());

  await page.keyboard.type(
    "printf '\\033[?1049h\\033[H\\033[2Jfullscreen-top\\033[10;5Hfullscreen-mid\\033[12;1H'; read x; printf '\\033[?1049l'",
  );
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(terminal)).toContain("fullscreen-mid");

  await dropAndReconnect(page, link);
  // What the program echoes comes behind the repaint on the same stream: once it shows, the repaint has been drawn.
  await page.keyboard.type("typed-after");
  await expect.poll(() => screenText(terminal), { timeout: 30_000 }).toContain("typed-after");
  // The program's screen is drawn again as it was, and the prompt screen behind it is not shown over it.
  const screen = await screenText(terminal);
  expect(screen).toContain("fullscreen-top");
  expect(screen).toContain("fullscreen-mid");
  expect(screen).not.toContain("marked$");
  const historyAfterFirst = await historyRows(terminal, row.height);

  await dropAndReconnect(page, link);
  await page.keyboard.type("-again");
  await expect.poll(() => screenText(terminal), { timeout: 30_000 }).toContain("typed-after-again");
  expect(await screenText(terminal)).not.toContain("marked$");
  // The primary screen is blank since the first repaint: the second one scrolls nothing into history.
  expect((await historyRows(terminal, row.height)) - historyAfterFirst).toBe(0);

  await page.keyboard.press("Enter");
  await page.keyboard.type("echo done-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("done-2", { timeout: 30_000 });
  // Every line printed before the program is there after it exits, once: on the screen or in history.
  const counts = await lineCounts(terminal, row.height);
  const printed = Array.from({ length: 200 }, (_, index) => index + 1);
  expect(printed.filter((line) => counts.get(line) !== 1)).toEqual([]);
});

/**
 * Try again after a refused reattach mounts a new, empty view: it has no history to keep, so it asks for the history as
 * a first attach does instead of the screen alone.
 */
test("Try again after a refused reattach brings the history back into its new view (#1997)", async ({ page }) => {
  const link = await routeHcSocket(page);
  const terminal = await openWithHistory(page, 300);
  const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());
  const oldestBefore = await oldestLine(terminal);
  const historyBefore = await historyRows(terminal, row.height);
  expect(historyBefore).toBeGreaterThan(200);

  const release = link.hold("terminal.attach");
  await dropAndReconnect(page, link);
  // The core refuses the reattach while the program still runs: the pane says the terminal did not open.
  release(true);
  await expect(page.getByRole("heading", { name: "This terminal didn't open" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(terminal).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  await expect(terminal).toContainText("line-300", { timeout: 15_000 });
  await expect.poll(() => historyRows(terminal, row.height), { timeout: 15_000 }).toBeGreaterThan(historyBefore - 6);
  expect(await oldestLine(terminal)).toBe(oldestBefore);
});
