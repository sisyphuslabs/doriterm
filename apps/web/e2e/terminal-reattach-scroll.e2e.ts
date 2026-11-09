import { expect, laidOutBox, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

test.use({ serviceWorkers: "block" });

/** The final buffer is correct whether or not the view walked down the history, so this samples the distance from
the view's end every frame across the reattach: one frame up in the history fails it (#1040). */
test("a reattach paints no frame with the view up in the history (#1040)", async ({ page }) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("seq 1 400; echo tail-$((20+2))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("tail-22", { timeout: 15_000 });

  const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());
  expect(row.height).toBeGreaterThan(0);

  await terminal.evaluate((element) => {
    const gaps: number[] = [];
    let running = true;
    Reflect.set(window, "__reattachGaps", gaps);
    Reflect.set(window, "__stopReattachGaps", () => {
      running = false;
      return gaps;
    });
    const sample = (): void => {
      gaps.push(Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop));
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const opened = socket.opened();
  await socket.drop(true);
  socket.restore();
  await expect.poll(socket.opened, { timeout: 15_000 }).toBeGreaterThan(opened);
  await expect(terminal).toContainText("tail-22", { timeout: 15_000 });

  const gaps: number[] = await page.evaluate(() => {
    const stop: unknown = Reflect.get(window, "__stopReattachGaps");
    if (typeof stop !== "function") throw new Error("the sampler was not installed");
    return (stop as () => number[])();
  });
  expect(gaps.length).toBeGreaterThan(0);
  expect(Math.max(...gaps)).toBeLessThan(row.height * 2);
});

/**
 * The other side of #1040: a reader up in the history must not be dragged down by the replay (#1393), and must be put
 * back where they were. The end-hold used to decide from the emptied buffer, which always reads as "at the end", so it
 * pinned every reader to the bottom; then it let go before the replay's last batch painted, which left them a screen
 * higher than they were (#1394 review).
 */
test("a reader up in the history is not pulled to the bottom by a reattach (#1393)", async ({ page }) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("seq 1 400; echo tail-$((20+2))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("tail-22", { timeout: 15_000 });

  const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());
  expect(row.height).toBeGreaterThan(0);

  // Mid-history, where the position has room to move both ways: at the top the hold's drift would clamp to 0.
  const awayBefore = await terminal.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
    return element.scrollHeight - element.clientHeight - element.scrollTop;
  });
  expect(awayBefore).toBeGreaterThan(row.height * 2);

  await terminal.evaluate((element) => {
    const pulled: number[] = [];
    let running = true;
    Reflect.set(window, "__reattachPulled", pulled);
    Reflect.set(window, "__stopReattachPulled", () => {
      running = false;
      return pulled;
    });
    const sample = (): void => {
      const gap = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
      // Only a frame with history above it can say the reader was pulled down; an emptied buffer has nowhere to scroll.
      if (element.scrollHeight - element.clientHeight > 1 && gap <= 1) pulled.push(gap);
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const opened = socket.opened();
  await socket.drop(true);
  socket.restore();
  await expect.poll(socket.opened, { timeout: 15_000 }).toBeGreaterThan(opened);
  await expect(terminal).toContainText("tail-22", { timeout: 15_000 });

  const pulled: number[] = await page.evaluate(() => {
    const stop: unknown = Reflect.get(window, "__stopReattachPulled");
    if (typeof stop !== "function") throw new Error("the sampler was not installed");
    return (stop as () => number[])();
  });
  expect(pulled).toEqual([]);
  // Back where they were: the same distance from the end, within a row.
  const awayAfter = await terminal.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
  expect(Math.abs(awayAfter - awayBefore)).toBeLessThan(row.height);
});
