import type { WTerm } from "@wterm/react";
import { cellText, type OverlaySource } from "./prediction-cells.ts";

/** What a spec's stand-in predictor reads of a view: its cursor, and a cell's text from the terminal's own core. */
export interface SeamScreen {
  cursor(): { readonly row: number; readonly col: number };
  cell(row: number, col: number): string;
  /** Called right after each write reaches the terminal, inside the frame that wrote it, as the predictor's own hook. */
  onWrite(listener: () => void): () => void;
}

/**
 * A test hook: e2e sets `window.__dorifacePredict` before the page loads to a function from a view's screen to the source
 * its prediction overlay draws, so an overlay spec controls exactly what is predicted. When it is set it replaces the real
 * predictor (prediction-view.ts) for that view; nothing in the app sets it.
 */
export function predictionSeam(wt: WTerm | null): OverlaySource | null {
  const seam: unknown = Reflect.get(globalThis, "__dorifacePredict");
  if (wt === null || typeof seam !== "function") return null;
  const writes = new Set<() => void>();
  const write = wt.write.bind(wt);
  wt.write = (data) => {
    write(data);
    for (const listener of writes) listener();
  };
  const screen: SeamScreen = {
    onWrite: (listener) => {
      writes.add(listener);
      return () => writes.delete(listener);
    },
    cursor: () => {
      const cursor = wt.bridge?.getCursor();
      return { row: cursor?.row ?? 0, col: cursor?.col ?? 0 };
    },
    cell: (row, col) => {
      const bridge = wt.bridge;
      return bridge === null ? "" : cellText(bridge.getCell(row, col));
    },
  };
  const source: unknown = Reflect.apply(seam, undefined, [screen]);
  return isSource(source) ? source : null;
}

function isSource(value: unknown): value is OverlaySource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "visible") === "function" &&
    typeof Reflect.get(value, "subscribe") === "function"
  );
}
