import type { Locator, Page } from "@playwright/test";

/**
 * Records what each frame paints on one row from `col`, `length` cells: an overlay cell where the prediction layer draws
 * one, else the grid row's own text. Sampled in a ResizeObserver callback, which runs after every animation-frame
 * callback of the frame (the pacer's write, the renderer, the overlay) and before the paint, so a sample is the frame as
 * painted, not a midpoint of it. Narrow text only: the grid row's text is read one character per cell.
 */
export async function startRowSampler(terminal: Locator, row: number, col: number, length: number): Promise<void> {
  await terminal.evaluate(
    (element, [r, c, n]) => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-10px;top:-10px;height:1px;pointer-events:none";
      document.body.appendChild(probe);
      const samples: string[] = [];
      let frame = 0;
      let on = true;
      const sample = (): void => {
        const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
        const first = element.querySelector(".term-grid .term-row:not(.term-scrollback-row)")?.getBoundingClientRect();
        const rows = element.querySelectorAll(".term-grid .term-row:not(.term-scrollback-row)");
        const chars = [...(rows[r]?.textContent ?? "").padEnd(c + n)].slice(c, c + n);
        for (const span of element.querySelectorAll(".term-prediction-cell")) {
          const box = span.getBoundingClientRect();
          if (first === undefined || Math.round((box.top - first.top) / first.height) !== r) continue;
          const at = Math.round((box.left - first.left) / cell) - c;
          if (at >= 0 && at < n) chars[at] = span.textContent ?? "";
        }
        samples.push(chars.join(""));
      };
      new ResizeObserver(() => {
        if (on) sample();
      }).observe(probe);
      const tick = (): void => {
        frame += 1;
        probe.style.width = `${1 + (frame % 2)}px`;
        if (on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      Reflect.set(window, "__rowSamples", () => {
        on = false;
        probe.remove();
        return samples;
      });
    },
    [row, col, length] as const,
  );
}

/** Stops the sampler and returns every frame's painted row text, in order. */
export const stopRowSampler = (page: Page) =>
  page.evaluate(() => (Reflect.get(window, "__rowSamples") as () => string[])());

/** How many leading characters of `typed` a painted row shows. */
export const shownPrefix = (painted: string, typed: string): number => {
  let shown = 0;
  while (shown < typed.length && painted[shown] === typed[shown]) shown += 1;
  return shown;
};
