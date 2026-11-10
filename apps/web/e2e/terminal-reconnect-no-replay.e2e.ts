import type { Locator, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, laidOutBox, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

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
 * printed them may be above it). Leaves the view at its end.
 */
async function oldestLine(terminal: Locator): Promise<number> {
  await terminal.evaluate((element) => {
    element.scrollTop = 0;
  });
  const first = (): Promise<number> =>
    terminal.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const rows = [...element.querySelectorAll(".term-grid .term-row")].filter(
        (row) => row.getBoundingClientRect().bottom > top,
      );
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
  const before = link.opened();
  await link.drop(true);
  link.restore();
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, "__dorifaceAttachLog") as unknown[]).length))
    .toBeGreaterThanOrEqual(2);
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
