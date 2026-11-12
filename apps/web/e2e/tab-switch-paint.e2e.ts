import type { Locator, Page } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const FIRST = 400;
const LAST = 800;
/** A wide line, so the output the hidden tab gathers is many frames' worth of bytes. */
const WIDE = `line-%g ${"=".repeat(90)}`;
/**
 * History above the screen, then a program that says so whenever its terminal is resized (RESIZED, written so that the
 * command line itself cannot contain it), and prints the rest of the history once `$GO` appears, writing `$DONE` after.
 */
const HISTORY_THEN_WATCH = `seq -f '${WIDE}' 1 ${FIRST}; bash -c 'trap "echo RE""SIZED" WINCH; while sleep 0.1; do if [ -e "$GO" ]; then rm "$GO"; seq -f "${WIDE}" ${FIRST + 1} ${LAST}; : > "$DONE"; fi; done'`;

/**
 * Records, for every frame as painted, whether the terminal is laid out and the highest `line-N` among its rows that are
 * inside its box (0 when none): what a person sees of it. Sampled in a ResizeObserver callback, which runs after every
 * animation-frame callback of the frame and before the paint (as e2e/prediction-frames.ts does).
 */
async function startVisibleLineSampler(terminal: Locator): Promise<void> {
  await terminal.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10px;top:-10px;height:1px;pointer-events:none";
    document.body.appendChild(probe);
    const samples: { shown: boolean; last: number }[] = [];
    let frame = 0;
    let on = true;
    const sample = (): void => {
      const box = element.getBoundingClientRect();
      const shown = box.width > 0 && box.height > 0;
      let last = 0;
      for (const row of element.querySelectorAll(".term-row")) {
        const at = row.getBoundingClientRect();
        if (at.height === 0 || at.bottom <= box.top + 1 || at.top >= box.bottom - 1) continue;
        for (const match of (row.textContent ?? "").matchAll(/line-(\d+)/g)) last = Math.max(last, Number(match[1]));
      }
      samples.push({ shown, last });
    };
    new ResizeObserver(() => {
      if (on) sample();
    }).observe(probe);
    const tick = (): void => {
      frame += 1;
      probe.style.width = `${1 + (frame % 2)}px`;
      if (on) requestAnimationFrame(tick);
    };
    Reflect.set(window, "__shownFrames", () => samples.filter((each) => each.shown).length);
    Reflect.set(window, "__visibleLines", () => {
      on = false;
      probe.remove();
      return samples;
    });
    requestAnimationFrame(tick);
  });
}

const sampledFrames = (page: Page): Promise<{ shown: boolean; last: number }[]> =>
  page.evaluate(() => (Reflect.get(window, "__visibleLines") as () => { shown: boolean; last: number }[])());

test("switching back to a tab paints the output it gathered while hidden from its first frame, and never resizes its program (#1588, #2391)", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "doriface-tab-switch-"));
  const go = join(dir, "go");
  const done = join(dir, "done");
  try {
    await page.goto("/");
    const first = await openNewTerminal(page);
    await first.getByRole("textbox").focus();
    await page.keyboard.type(`export GO=${go} DONE=${done}; ${HISTORY_THEN_WATCH}`);
    await page.keyboard.press("Enter");
    await expect(first.locator(".term-row").filter({ hasText: `line-${FIRST} ` })).not.toHaveCount(0, {
      timeout: 30_000,
    });

    // A second tab hides the first one, which stays mounted with its stream.
    await openNewTerminal(page);
    await expect(first).toBeHidden();
    // While it is out of view its program prints the rest of its history: a backlog of many frames' worth, which the tab
    // holds until it shows (#1588).
    // The pane learns it is hidden from an observer a frame or so after it is: two frames on, its pacer holds output.
    await page.evaluate(
      () => new Promise<void>((settle) => requestAnimationFrame(() => requestAnimationFrame(() => settle()))),
    );
    writeFileSync(go, "");
    await expect.poll(() => existsSync(done), { timeout: 30_000 }).toBe(true);

    await startVisibleLineSampler(first);
    await page.getByRole("tablist", { name: "Tabs" }).getByRole("tab").first().click();
    await expect(first).toBeVisible();
    // Sixty painted frames after it shows: a switch that paints in steps, or a resize its program answers, shows by then.
    await expect
      .poll(() => page.evaluate(() => (Reflect.get(window, "__shownFrames") as () => number)()), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(60);
    const frames = await sampledFrames(page);
    const shown = frames.filter((frame) => frame.shown);
    console.log(`tab-switch frames: ${JSON.stringify(shown.map((frame) => frame.last))}`);

    expect(shown.length).toBeGreaterThan(0);
    // Every frame it is on screen shows the end of what it gathered while hidden, the first one included: neither its
    // screen from before it was hidden (#2391) nor a climb through the backlog (#1588).
    expect(shown.map((frame) => frame.last)).toEqual(shown.map(() => LAST));
    // Hiding a tab is not a resize: its program was never told its terminal changed size.
    await expect(first).not.toContainText("RESIZED");

    await first.getByRole("textbox").focus();
    await page.keyboard.press("Control+C");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LONG = 1500;
/** Wide lines, so the replay of the history is many frames' worth of bytes. */
const LONG_HISTORY = `seq -f 'line-%g ${"=".repeat(90)}' 1 ${LONG}`;

test("a tab restored out of view shows its history at its end when first shown over a slow link, never climbing from the top (#1588)", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const first = await openNewTerminal(page);
  await first.getByRole("textbox").focus();
  await page.keyboard.type(LONG_HISTORY);
  await page.keyboard.press("Enter");
  await expect(first.locator(".term-row").filter({ hasText: `line-${LONG} ` })).not.toHaveCount(0, { timeout: 30_000 });
  await openNewTerminal(page);

  // The app starts again over the relay: the saved layout brings both tabs back with the second one shown.
  link.delay(150);
  await page.reload();
  const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(first).toBeAttached({ timeout: 20_000 });
  await expect(first).toBeHidden();

  await startVisibleLineSampler(first);
  await tabs.nth(0).click();
  await expect(first.locator(".term-row").filter({ hasText: `line-${LONG} ` })).not.toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, "__shownFrames") as () => number)()), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(60);
  const shown = (await sampledFrames(page)).filter((frame) => frame.shown).map((frame) => frame.last);
  console.log(`first-show frames: ${JSON.stringify(shown)}`);

  // Until the history is there the tab shows none of it; from then on, its end. Never a part of it on the way down.
  expect(shown.filter((last) => last !== 0 && last !== LONG)).toEqual([]);
  expect(shown.at(-1)).toBe(LONG);
});
