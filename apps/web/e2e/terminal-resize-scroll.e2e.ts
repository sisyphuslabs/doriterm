import type { Locator, Page } from "@playwright/test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { fakeSoftKeyboard, PHONE, showKeyboard } from "./phone-key-bar.ts";
import { synchronizedUpdates, watchSynchronizedUpdates } from "./synchronized-updates.ts";
import { expectFollowed, sampleWhile } from "./transcript-follow.ts";

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

test("a following terminal stays on its last line, in every frame painted inside the synchronized-update hold, through window resizes that redraw an agent's transcript", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "doriface-resize-scroll-"));
  try {
    const agent = startAgent(dir);
    seedLayout([{ id: "tb-757", name: "agent", root: [{ pane: "p1", terminal: agent.address }] }]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await watchSynchronizedUpdates(page);
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
      expectFollowed(samples, await synchronizedUpdates(page), LINES);
    };
    await resize(960);
    await resize(1280);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a following terminal stays on its last line, in every frame painted inside the synchronized-update hold, while a split divider is dragged", async ({
  page,
}) => {
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
    await watchSynchronizedUpdates(page);
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
    expectFollowed(samples, await synchronizedUpdates(page), LINES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.describe("on a phone", () => {
  test.use({ ...PHONE });

  test("a following terminal stays on its last line, in every frame painted inside the synchronized-update hold, as the soft keyboard opens and closes", async ({
    page,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "doriface-resize-scroll-"));
    try {
      const agent = startAgent(dir);
      seedLayout([{ id: "tb-757", name: "agent", root: [{ pane: "p1", terminal: agent.address }] }]);
      await fakeSoftKeyboard(page, { raiseOnFocus: false });
      await watchSynchronizedUpdates(page);
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
        expectFollowed(samples, await synchronizedUpdates(page), LINES, { atBottom: false });
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
