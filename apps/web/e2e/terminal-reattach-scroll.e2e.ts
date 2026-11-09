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

/**
 * The terminal moves the scroller itself during a reattach: its reset's render scrolls to the top, and when that render
 * lands after the hold has placed the reader, the view sits at the top with no reader having touched it. The hold read
 * any move away from where it put them as the reader's own and let go, leaving them at the top of the history (#1394).
 * Only the reader's input ends the hold; this moves the view the way the terminal does, with no input.
 */
test("a scroll the reader did not make during a reattach does not end the hold (#1394)", async ({ page }) => {
  let answered: (() => void) | null = null;
  const socket = await routeHcSocket(page, {
    received: (frame) => {
      if (frame.includes('"resize_notifications"')) answered?.();
    },
  });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("seq 1 400; echo tail-$((20+2))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("tail-22", { timeout: 15_000 });

  const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());
  expect(row.height).toBeGreaterThan(0);
  const awayBefore = await terminal.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
    return element.scrollHeight - element.clientHeight - element.scrollTop;
  });
  expect(awayBefore).toBeGreaterThan(row.height * 2);

  // The replay waits until the stray scroll has happened, so the hold is in the middle of its work when it comes.
  const reattached = new Promise<void>((resolve) => {
    answered = resolve;
  });
  await socket.drop(true);
  const releaseReplay = socket.holdFromHost("tail-22");
  socket.restore();
  await reattached;
  // Two frames: the reset written on the answer paints, and the hold places the reader after it.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await terminal.evaluate((element) => {
    element.scrollTop = 0;
  });
  releaseReplay();

  await expect
    .poll(() => terminal.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop), {
      timeout: 15_000,
    })
    .toBeLessThan(awayBefore + row.height);
  const awayAfter = await terminal.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
  expect(Math.abs(awayAfter - awayBefore)).toBeLessThan(row.height);
});
