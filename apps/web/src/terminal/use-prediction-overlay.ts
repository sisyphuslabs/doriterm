import type { WTerm } from "@wterm/react";
import { useEffect } from "react";
import { wideGlyphScaler } from "./face-scales.ts";
import { drawnCells, type PlacedPrediction, type OverlaySource, placeCells } from "./prediction-cells.ts";

/** Within a pixel of the bottom: the view shows the active screen, which predictions anchor to. */
const atEnd = (element: HTMLElement): boolean => element.scrollHeight - element.clientHeight - element.scrollTop <= 1;

/** The layer's spans, a wide cell at the size its committed glyph will have, as the renderer builds a row's cells. */
function predictionSpans(element: HTMLElement, placed: PlacedPrediction): HTMLElement[] {
  const scale = wideGlyphScaler(element);
  const span = (className: string, left: number, top: number): HTMLElement => {
    const made = element.ownerDocument.createElement("span");
    made.className = className;
    made.style.left = `${left}px`;
    made.style.top = `${top}px`;
    return made;
  };
  const cells = placed.cells.map((cell) => {
    const made = span(cell.wide ? "term-prediction-cell term-wide" : "term-prediction-cell", cell.left, cell.top);
    const factor = cell.wide ? (scale?.(cell.text) ?? 1) : 1;
    if (factor !== 1) made.style.fontSize = `${factor}em`;
    made.textContent = cell.text;
    return made;
  });
  if (placed.cursor !== null) cells.push(span("term-prediction-cursor", placed.cursor.left, placed.cursor.top));
  return cells;
}

/**
 * Draws a predictor's cells over the grid in a layer of their own (design D1), as `use-preedit.ts` draws a composition:
 * each predicted cell in its column and row of the active screen, underlined, a wide one over two cells at its fitted
 * size, and a predicted cursor after the last, while the real cursor is not drawn (`data-predicting`). The terminal is
 * only read: each draw checks the predictions against its cells and cursor (`drawnCells`), so a cell the echo already
 * shows is dropped. Drawn again whenever the source, the grid, its size or its scroll changes; hidden while the view
 * is scrolled back from the end (rule P11), since the layer anchors to active-screen rows.
 */
export function usePredictionOverlay(wt: WTerm | null, source: OverlaySource | null): void {
  useEffect(() => {
    if (wt === null || source === null) return undefined;
    const element = wt.element;
    const grid = element.querySelector<HTMLElement>(".term-grid") ?? element;
    const layer = element.ownerDocument.createElement("div");
    layer.className = "term-prediction";
    layer.setAttribute("aria-hidden", "true");
    let drawn = "";
    let frame = 0;
    let watching = false;
    const changed = new MutationObserver(() => schedule());
    const resized = new ResizeObserver(() => schedule());
    const watch = (on: boolean): void => {
      if (on === watching) return;
      watching = on;
      if (on) {
        // The layer sits outside the grid, so drawing it does not wake these.
        changed.observe(grid, { childList: true, subtree: true, characterData: true, attributes: true });
        resized.observe(element);
        element.addEventListener("scroll", schedule, { passive: true });
      } else {
        changed.disconnect();
        resized.disconnect();
        element.removeEventListener("scroll", schedule);
      }
    };
    const hide = (): void => {
      drawn = "";
      layer.remove();
      delete element.dataset["predicting"];
    };
    const draw = (): void => {
      const predicted = source.visible();
      watch(predicted.length > 0);
      const bridge = wt.bridge;
      const first = element.querySelector<HTMLElement>(".term-row:not(.term-scrollback-row)");
      const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
      if (bridge === null || first === null || !(cell > 0) || !atEnd(element)) return hide();
      const cells = drawnCells(predicted, bridge);
      if (cells.length === 0) return hide();
      const host = element.getBoundingClientRect();
      const origin = first.getBoundingClientRect();
      const left = origin.left - host.left - element.clientLeft + element.scrollLeft;
      const top = origin.top - host.top - element.clientTop + element.scrollTop;
      const box = { left, top, cell, row: origin.height, cols: bridge.getCols() };
      const placed = placeCells(cells, box, bridge.getCursor().visible);
      const shape = grid.dataset["cursorShape"] ?? "block";
      const key = JSON.stringify([placed, shape]);
      if (key !== drawn) {
        drawn = key;
        layer.dataset["cursorShape"] = shape;
        layer.replaceChildren(...predictionSpans(element, placed));
      }
      if (layer.parentElement !== element) element.appendChild(layer);
      element.dataset["predicting"] = "";
    };
    function schedule(): void {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    }
    const unsubscribe = source.subscribe(schedule);
    schedule();
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      watch(false);
      hide();
    };
  }, [wt, source]);
}
