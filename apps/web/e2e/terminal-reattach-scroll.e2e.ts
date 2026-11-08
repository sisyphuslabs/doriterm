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
