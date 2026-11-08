import type { WTerm } from "@wterm/react";
import { useEffect, useMemo } from "react";
import { wideGlyphScaler } from "./face-scales.ts";
import {
  drawnCells,
  type OverlaySource,
  type PlacedPrediction,
  type PredictedCell,
  placeCells,
} from "./prediction-cells.ts";
import { paintedCells, predictedCursor } from "./prediction-hold.ts";

/** Where typing goes next while predictions are painted (null: at the real cursor), and a call when that moves. */
export interface PredictedCursor {
  cursor(): { readonly row: number; readonly col: number } | null;
  subscribe(changed: () => void): () => void;
}

function cursorChannel(): PredictedCursor & { set(next: ReturnType<PredictedCursor["cursor"]>): void } {
  let current: ReturnType<PredictedCursor["cursor"]> = null;
  const listeners = new Set<() => void>();
  return {
    cursor: () => current,
    subscribe: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    set: (next) => {
      if (next?.row === current?.row && next?.col === current?.col) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

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
 * only read: each draw checks the predictions against its cells and cursor (`drawnCells`). A change from the predictor
 * is painted at once, so an addition shows in the frame its key is typed in; a cell that leaves is painted away only
 * once the renderer has painted what replaced it (`paintedCells`): at the next grid change, or one frame later. Hidden
 * while the view is scrolled back from the end (rule P11), since the layer anchors to active-screen rows. Returns the
 * predicted cursor, for the composition to be drawn at.
 */
export function usePredictionOverlay(wt: WTerm | null, source: OverlaySource | null): PredictedCursor {
  const channel = useMemo(cursorChannel, []);
  useEffect(() => {
    if (wt === null || source === null) return undefined;
    const view = wt;
    const from = source;
    const element = view.element;
    const grid = element.querySelector<HTMLElement>(".term-grid") ?? element;
    const layer = element.ownerDocument.createElement("div");
    layer.className = "term-prediction";
    layer.setAttribute("aria-hidden", "true");
    let painted: readonly PredictedCell[] = [];
    let drawn = "";
    let frame = 0;
    let release = 0;
    let watching = false;
    const changed = new MutationObserver(() => paint(true));
    const resized = new ResizeObserver(() => schedule());
    const watch = (on: boolean): void => {
      if (on === watching) return;
      watching = on;
      if (on) {
        // The layer sits outside the grid, so painting it does not wake these.
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
      painted = [];
      drawn = "";
      layer.remove();
      delete element.dataset["predicting"];
      channel.set(null);
    };
    function paint(rendered: boolean): void {
      const predicted = from.visible();
      const bridge = view.bridge;
      const first = element.querySelector<HTMLElement>(".term-row:not(.term-scrollback-row)");
      const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
      if (bridge === null || first === null || !(cell > 0) || !atEnd(element)) {
        watch(predicted.length > 0);
        return hide();
      }
      const wanted = drawnCells(predicted, bridge);
      painted = paintedCells(wanted, painted, bridge, rendered);
      watch(predicted.length > 0 || painted.length > 0);
      if (painted.length > wanted.length && release === 0) {
        release = requestAnimationFrame(() => {
          release = 0;
          paint(true);
        });
      }
      if (painted.length === 0) return hide();
      const host = element.getBoundingClientRect();
      const origin = first.getBoundingClientRect();
      const left = origin.left - host.left - element.clientLeft + element.scrollLeft;
      const top = origin.top - host.top - element.clientTop + element.scrollTop;
      const cols = bridge.getCols();
      const placed = placeCells(painted, { left, top, cell, row: origin.height, cols }, bridge.getCursor().visible);
      const shape = grid.dataset["cursorShape"] ?? "block";
      const key = JSON.stringify([placed, shape]);
      if (key !== drawn) {
        drawn = key;
        layer.dataset["cursorShape"] = shape;
        layer.replaceChildren(...predictionSpans(element, placed));
      }
      if (layer.parentElement !== element) element.appendChild(layer);
      element.dataset["predicting"] = "";
      channel.set(predictedCursor(painted, cols));
    }
    function schedule(): void {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint(false);
      });
    }
    const unsubscribe = source.subscribe(() => paint(false));
    paint(false);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(release);
      watch(false);
      hide();
    };
  }, [wt, source, channel]);
  return channel;
}
