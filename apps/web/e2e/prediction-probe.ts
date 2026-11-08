import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

interface Predictor {
  add(text: string, width: 1 | 2): { row: number; col: number; width: 1 | 2 };
  typing(on: boolean): void;
  cell(row: number, col: number): string;
}

/** From now on the stand-in predicts each printable key and each committed composition, as the input path will. */
export const predictTyping = (page: Page) =>
  page.evaluate(() => (Reflect.get(window, "__predictor") as Predictor).typing(true));

/**
 * Predicts `text` and counts the animation frames until the overlay draws it, so a spec can bound the delay; -1 when it
 * is not drawn within ten frames, or when no view took the hook (a build with no prediction overlay).
 */
export const predict = (page: Page, text: string, width: 1 | 2 = 1) =>
  page.evaluate(
    ([chars, cells]) =>
      new Promise<{ row: number; col: number; frames: number }>((resolve) => {
        const predictor = Reflect.get(window, "__predictor") as Predictor | undefined;
        if (predictor === undefined) return resolve({ row: -1, col: -1, frames: -1 });
        const drawn = document.querySelectorAll(".term-prediction-cell").length;
        const cell = predictor.add(chars, cells);
        let frames = 0;
        const tick = (): void => {
          frames += 1;
          if (document.querySelectorAll(".term-prediction-cell").length > drawn) resolve({ ...cell, frames });
          else if (frames >= 10) resolve({ ...cell, frames: -1 });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [text, width] as const,
  );

/** The text of the terminal's own cell, read from its core: blank ("" or " ") while nothing is printed there. */
export const realCell = (page: Page, row: number, col: number) =>
  page.evaluate(([r, c]) => (Reflect.get(window, "__predictor") as Predictor).cell(r, c), [row, col] as const);

/** The real cursor cell, the predicted cells and the predicted cursor as painted, with what a spec checks of each. */
export const painted = (element: HTMLElement) => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- evaluate sends this function as source, so its helpers live inside it
  const box = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const cursor = element.querySelector(".term-grid .term-cursor");
  const cursorStyle = cursor === null ? null : getComputedStyle(cursor);
  const predictedCursor = element.querySelector(".term-prediction-cursor");
  const grid = element.querySelector(".term-grid") ?? element;
  const committed = [...element.querySelectorAll(".term-grid .term-row:not(.term-scrollback-row) .term-wide")].at(-1);
  return {
    cell: Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width")),
    predicting: element.dataset["predicting"] !== undefined,
    termColor: getComputedStyle(grid).color,
    termBackground: getComputedStyle(element).backgroundColor,
    cursor:
      cursor === null || cursorStyle === null
        ? null
        : { ...box(cursor), background: cursorStyle.backgroundColor, shadow: cursorStyle.boxShadow },
    committedWide:
      committed === undefined ? null : { ...box(committed), fontSize: getComputedStyle(committed).fontSize },
    cells: [...element.querySelectorAll(".term-prediction-cell")].map((cell) => {
      const style = getComputedStyle(cell);
      return Object.assign(box(cell), {
        text: cell.textContent,
        wide: cell.classList.contains("term-wide"),
        underline: style.textDecorationLine,
        fontSize: style.fontSize,
        color: style.color,
        background: style.backgroundColor,
      });
    }),
    predictedCursor: predictedCursor === null ? null : box(predictedCursor),
  };
};

/**
 * Waits until the shell at an empty `$` prompt is reading keys: types a marker, waits for its echo, erases it and waits
 * for the erase. A key typed while the shell is still redrawing its line (a phone's keyboard resizing the grid as the
 * terminal takes focus) can reach the pty and never be echoed, so a spec about echoes starts only after this.
 */
export async function untilShellReads(page: Page, terminal: Locator): Promise<void> {
  const prompt = terminal.locator(".term-row:not(.term-scrollback-row)");
  await page.keyboard.type("#");
  await expect(prompt.filter({ hasText: /^\$ # *$/ })).toHaveCount(1, { timeout: 15_000 });
  await page.keyboard.press("Backspace");
  await expect(prompt.filter({ hasText: /^\$ # *$/ })).toHaveCount(0, { timeout: 15_000 });
}
