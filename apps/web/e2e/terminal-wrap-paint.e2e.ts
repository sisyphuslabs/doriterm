import type { Locator, Page } from "@playwright/test";
import { gridSize } from "./core-size.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { PHONE, openPhoneTerminal } from "./phone-key-bar.ts";
import { installPredictor } from "./prediction-stand-in.ts";

/** Messages the page's WebSocket handlers received: one per hc frame before #1462, one per host message after it. */
const pageMessages = (page: Page): Promise<number> =>
  page.evaluate(() => Number(Reflect.get(window, "__hostMessages") ?? 0));

/** Counts the page's host messages, through the hook the prediction stand-in already installs. */
async function countMessages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.set(window, "__hostMessages", 0);
    Reflect.set(window, "__afterHostMessage", () =>
      Reflect.set(window, "__hostMessages", Number(Reflect.get(window, "__hostMessages")) + 1),
    );
  });
}

/**
 * The grid's first three rows as painted, and as the terminal's core holds them, side by side: each row trimmed and
 * concatenated, so a soft-wrapped line reads as one string and a row that is one frame behind reads as a difference.
 */
const firstRows = (terminal: Locator, cols: number): Promise<{ dom: string; core: string }> =>
  terminal.evaluate((element, width) => {
    const predictor = Reflect.get(window, "__predictor") as { cell(row: number, col: number): string } | undefined;
    const painted = [...element.querySelectorAll<HTMLElement>(".term-row:not(.term-scrollback-row)")];
    const core = (row: number): string => {
      let out = "";
      for (let col = 0; col < width; col += 1) {
        const text = predictor?.cell(row, col) ?? "";
        out += text === "" ? " " : text;
      }
      return out.replace(/\s+$/, "");
    };
    return {
      dom: [0, 1, 2].map((row) => (painted[row]?.textContent ?? "").replace(/\s+$/, "")).join(""),
      core: [0, 1, 2].map(core).join(""),
    };
  }, cols);

const frames = (page: Page, count: number): Promise<void> =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const tick = (): void => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );

test("the harness hands the page the host's own messages, not one message a frame", async ({ page }) => {
  await installPredictor(page);
  await countMessages(page);
  const link = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  // The attach replay and the prompt: the host sends them as messages of several frames, and the page must take them
  // as messages, not as one page message per frame. A page message is a driver round trip into the browser, so a frame
  // a message multiplies the time a typed line takes to reach the core; under load it reached it after the probe gave
  // up, which is what #1462 saw (#1462).
  await expect.poll(() => pageMessages(page), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await pageMessages(page)).toBeLessThanOrEqual(link.messages());
});

for (const device of ["desktop", "phone"] as const) {
  test.describe(`${device} wrapped line`, () => {
    test.use(device === "phone" ? PHONE : {});

    test("a typed wrapped line's continuation row is painted within a frame of the core", async ({ page }) => {
      await installPredictor(page);
      await page.goto("/");
      const terminal = device === "phone" ? await openPhoneTerminal(page) : await openNewTerminal(page);
      await terminal.getByRole("textbox").focus();
      const cols = Number((await gridSize(terminal)).split(" ")[1]);
      const typed = "x".repeat(cols + 3);
      await page.keyboard.insertText(typed);
      // The echo reaches the terminal's core…
      await expect.poll(async () => (await firstRows(terminal, cols)).core, { timeout: 15_000 }).toContain(typed);
      // …and the grid follows it within the frames the renderer and the overlay take, not never: a row the renderer
      // does not repaint leaves the painted rows behind the core's for good (#1462).
      await frames(page, 2);
      const painted = await firstRows(terminal, cols);
      expect(painted.dom).toBe(painted.core);
    });
  });
}
