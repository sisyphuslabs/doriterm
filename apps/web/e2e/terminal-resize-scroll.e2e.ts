import type { Locator, Page } from "@playwright/test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { fakeSoftKeyboard, PHONE, showKeyboard } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const LINES = 5000;

/**
 * An agent's transcript as pi-tui (omo, senpi) and Claude Code draw it outside a multiplexer: on every width change the
 * whole transcript again, as one synchronized update (DECSET 2026) that clears the screen and the scrollback first. A
 * native terminal swaps it in at once, and so must the view (#757). Like a TUI, it builds a frame first and then writes
 * it whole; each finished frame leaves a marker file.
 */
const AGENT = String.raw`stty -echo
drawn=0
frame() {
  cols=$(tput cols)
  awk -v n=${LINES} -v c="$cols" 'BEGIN { fill = ""; for (k = 0; k < c - 10; k++) fill = fill "."
    for (i = 1; i <= n; i++) printf "\033[38;5;%dmrow %05d\033[0m %s%s", 240 + i % 10, i, fill, (i < n ? "\r\n" : "") }' > "$DRAWN.frame"
  printf '\033[?2026h\033[?7l\033[2J\033[H\033[3J'
  cat "$DRAWN.frame"
  printf '\033[?7h\033[?2026l'
  drawn=$((drawn + 1))
  : > "$DRAWN.$drawn"
}
trap frame WINCH
frame
while :; do sleep 1 & wait $!; done
`;

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) hcOn("host", ["kill", address]);
});

/** Starts the agent on the core; `frames()` counts the frames it has finished writing. */
function startAgent(dir: string): { readonly address: string; readonly frames: () => number } {
  const script = join(dir, "agent.sh");
  const marker = join(dir, "drawn");
  writeFileSync(script, AGENT);
  const out = hcOn("host", ["run", "--bg", "--name", "resize-agent", "--", "env", `DRAWN=${marker}`, "bash", script]);
  const address = String((JSON.parse(out) as { address: string }).address);
  started.push(address);
  return { address, frames: () => readdirSync(dir).filter((name) => /^drawn\.\d+$/.test(name)).length };
}

const terminalOf = (page: Page, address: string): Locator => page.locator(`[data-terminal="${address}"]`);

const fromBottom = (terminal: Locator): Promise<number> =>
  terminal.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);

/** The view at the bottom, its screen showing the transcript's last line. */
async function atLastLine(terminal: Locator): Promise<void> {
  await expect(terminal.locator(".term-row:not(.term-scrollback-row)").last()).toContainText(
    `row ${String(LINES).padStart(5, "0")}`,
    { timeout: 30_000 },
  );
  await expect.poll(() => fromBottom(terminal)).toBeLessThan(5);
}

interface Sample {
  readonly away: number;
  /** The newest transcript line the screen shows (the rest of a reflowed line shows none); 0 for none. */
  readonly newest: number;
  /**
   * The oldest transcript line inside the scroll element's visible box, scrollback rows included; 0 for none. A view
   * that jumps into the history shows old lines here, while the screen's rows (`newest`) stay mounted wherever it is.
   */
  readonly top: number;
  /** Rows on the screen, the view's height in lines. */
  readonly screen: number;
  /**
   * Rows inside the scroll element's visible box, scrollback rows included: more than `screen` when the sample is read
   * after a layout change and before the grid is fitted to it.
   */
  readonly inView: number;
}

/**
 * Samples the view after every paint until `change` is done: how far it is from the bottom, and the newest line its
 * screen shows. Each sample is what the user saw: read after the frame's ResizeObserver callbacks and paint, not in its
 * animation-frame callback, before a layout change has been fitted. The terminal is found by its address on each frame, as a layout
 * change can mount it anew; a frame without it records nothing.
 */
async function sampleWhile(page: Page, address: string, change: () => Promise<void>): Promise<Sample[]> {
  const samples = page.evaluate(
    (selector) =>
      new Promise<Sample[]>((resolve) => {
        const seen: Sample[] = [];
        const record = (): void => {
          const element = document.querySelector(selector);
          if (element !== null) {
            const rows = [...element.querySelectorAll(".term-row:not(.term-scrollback-row)")];
            // The visible box is the content box: both edges start below the border.
            const edge = element.getBoundingClientRect().top + element.clientTop;
            const bottom = edge + element.clientHeight;
            const inView = [...element.querySelectorAll(".term-row")].filter((row) => {
              const rect = row.getBoundingClientRect();
              return rect.bottom > edge + 1 && rect.top < bottom - 1;
            });
            const visible = inView
              .map((row) => Number(/row (\d{5})/.exec(row.textContent ?? "")?.[1] ?? 0))
              .filter((number) => number > 0);
            seen.push({
              away: element.scrollHeight - element.clientHeight - element.scrollTop,
              newest: Math.max(0, ...rows.map((row) => Number(/row (\d{5})/.exec(row.textContent ?? "")?.[1] ?? 0))),
              top: visible.length === 0 ? 0 : Math.min(...visible),
              screen: rows.length,
              inView: inView.length,
            });
          }
          if (document.documentElement.hasAttribute("data-e2e-stop-sampling")) {
            document.documentElement.removeAttribute("data-e2e-stop-sampling");
            resolve(seen);
          } else afterPaint();
        };
        // A message posted in a frame's callback is delivered once that frame is painted.
        const channel = new MessageChannel();
        channel.port1.addEventListener("message", record);
        channel.port1.start();
        const afterPaint = (): void => void requestAnimationFrame(() => channel.port2.postMessage(null));
        record();
      }),
    `[data-terminal="${address}"]`,
  );
  try {
    await change();
  } finally {
    // A change that fails still stops the sampler, so its own error is reported instead of a timeout here.
    await page.evaluate(() => document.documentElement.setAttribute("data-e2e-stop-sampling", ""));
  }
  return samples;
}

/**
 * Every sampled frame showed the transcript's end, and none scrolled back through it: the lines in view are all within
 * two views of the end, a view being the screen's rows or the rows the visible box holds, whichever is more. `atBottom`
 * also requires each frame at the scroll element's very bottom; a layout change that React commits in its own task can
 * be read after it lands and before the frame's ResizeObserver fits the grid to it, a state the browser never paints,
 * so that is checked only where no such change happens.
 */
function expectFollowed(samples: readonly Sample[], { atBottom = true } = {}): void {
  const off = samples.filter(
    (sample) =>
      sample.newest !== LINES ||
      sample.top <= LINES - 2 * Math.max(sample.screen, sample.inView) ||
      (atBottom && sample.away >= 5),
  );
  expect(samples.length).toBeGreaterThan(0);
  expect(off.slice(0, 5), `${off.length} of ${samples.length} frames left the transcript's end`).toEqual([]);
}

test("a following terminal stays on its last line through window resizes that redraw an agent's transcript", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "doriface-resize-scroll-"));
  try {
    const agent = startAgent(dir);
    seedLayout([{ id: "tb-757", name: "agent", root: [{ pane: "p1", terminal: agent.address }] }]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const terminal = terminalOf(page, agent.address);
    await atLastLine(terminal);
    const resize = async (width: number): Promise<void> => {
      const drawn = agent.frames();
      const samples = await sampleWhile(page, agent.address, async () => {
        await page.setViewportSize({ width, height: 800 });
        await expect.poll(agent.frames, { timeout: 30_000 }).toBeGreaterThan(drawn);
        await atLastLine(terminal);
      });
      expectFollowed(samples);
    };
    await resize(960);
    await resize(1280);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a following terminal stays on its last line while a split divider is dragged", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "doriface-resize-scroll-"));
  try {
    const agent = startAgent(dir);
    const shell = startShell("host", "resize-757-side");
    started.push(shell);
    seedLayout([
      {
        id: "tb-757",
        name: "split",
        root: [
          { pane: "p1", terminal: agent.address, weight: 0.6 },
          { pane: "p2", terminal: shell, weight: 0.4 },
        ],
      },
    ]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const terminal = terminalOf(page, agent.address);
    await atLastLine(terminal);
    const divider = page.locator('[role="separator"][data-container="tb-757"]');
    const line = await divider.boundingBox();
    if (line === null) throw new Error("no divider box");
    const [x, y] = [line.x + line.width / 2, line.y + line.height / 2];
    const drawn = agent.frames();
    const samples = await sampleWhile(page, agent.address, async () => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 240, y, { steps: 8 });
      await page.mouse.up();
      await expect.poll(agent.frames, { timeout: 30_000 }).toBeGreaterThan(drawn);
      await atLastLine(terminal);
    });
    expectFollowed(samples);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.describe("on a phone", () => {
  test.use({ ...PHONE });

  test("a following terminal stays on its last line as the soft keyboard opens and closes", async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "doriface-resize-scroll-"));
    try {
      const agent = startAgent(dir);
      seedLayout([{ id: "tb-757", name: "agent", root: [{ pane: "p1", terminal: agent.address }] }]);
      await fakeSoftKeyboard(page, { raiseOnFocus: false });
      await page.goto("/");
      await page
        .getByRole("button", { name: /resize-agent/ })
        .first()
        .click();
      const terminal = terminalOf(page, agent.address);
      await atLastLine(terminal);
      // The keyboard takes rows from the grid, as on a phone: the agent redraws for the new height.
      const keyboard = async (px: number): Promise<void> => {
        const drawn = agent.frames();
        const samples = await sampleWhile(page, agent.address, async () => {
          await showKeyboard(page, px);
          await expect.poll(agent.frames, { timeout: 30_000 }).toBeGreaterThan(drawn);
          await atLastLine(terminal);
        });
        expectFollowed(samples, { atBottom: false });
      };
      await keyboard(336);
      await keyboard(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The text of the first row in view (the top one the scroll box shows), trimmed. */
const firstInView = (terminal: Locator): Promise<string> =>
  terminal.evaluate((element) => {
    const top = element.getBoundingClientRect().top + (parseFloat(getComputedStyle(element).paddingTop) || 0);
    const row = [...element.querySelectorAll(".term-row")].find(
      (each) => each.getBoundingClientRect().bottom > top + 1,
    );
    return (row?.textContent ?? "").trim();
  });

test("a terminal scrolled into its history keeps the same line at the top through a resize", async ({ page }) => {
  const shell = startShell("host", "resize-757-history");
  started.push(shell);
  seedLayout([{ id: "tb-757", name: "history", root: [{ pane: "p1", terminal: shell }] }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const terminal = terminalOf(page, shell);
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  hcOn("host", ["send", shell, `seq -f 'line %05g' 1 ${LINES}`]);
  await expect(terminal.locator(".term-row:not(.term-scrollback-row)").filter({ hasText: /^line 05000/ })).toHaveCount(
    1,
    { timeout: 30_000 },
  );
  const rowHeight = await terminal.evaluate(
    (element) => element.querySelector(".term-row:not(.term-scrollback-row)")?.getBoundingClientRect().height ?? 0,
  );
  await terminal.evaluate((element, top) => {
    element.scrollTop = top;
  }, 1500 * rowHeight);
  await expect.poll(() => firstInView(terminal)).toMatch(/^line 015\d\d$/);
  const anchor = await firstInView(terminal);
  const box = (): Promise<string> => terminal.evaluate((element) => `${element.clientWidth}x${element.clientHeight}`);
  const resize = async (width: number, height: number): Promise<void> => {
    const before = await box();
    await page.setViewportSize({ width, height });
    await expect.poll(box).not.toBe(before);
    await expect.poll(() => firstInView(terminal)).toBe(anchor);
    expect(await fromBottom(terminal)).toBeGreaterThan(rowHeight);
  };
  await resize(900, 800);
  await resize(900, 600);
  await resize(1280, 800);
});
