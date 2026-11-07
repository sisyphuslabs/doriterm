import type { WTerm } from "@wterm/react";
import { useEffect } from "react";
import { wideGlyphScaler } from "./face-scales.ts";
import { CodepointWidths, type PreeditCodepoint, preeditRange } from "./preedit.ts";

/** The cells a preedit is drawn in, built as the renderer builds a row's cells so a wide one gets its fitted size. */
function preeditCells(element: HTMLElement, codepoints: readonly PreeditCodepoint[]): HTMLElement[] {
  const scale = wideGlyphScaler(element);
  return codepoints.map((codepoint) => {
    const cell = element.ownerDocument.createElement("span");
    if (codepoint.wide) {
      cell.className = "term-wide";
      const factor = scale?.(codepoint.text) ?? 1;
      if (factor !== 1) cell.style.fontSize = `${factor}em`;
    }
    cell.textContent = codepoint.text;
    return cell;
  });
}

/**
 * Draws the text an input method is composing as Ghostty does (renderer/generic.zig): as cells at the cursor, a wide
 * codepoint over two cells at the size its committed glyph will have, underlined, shifted left at the row's end, over the
 * cells it covers, and with no cursor drawn meanwhile. The input element keeps the composition; it only stops painting it
 * (#674). Like Ghostty's per-frame preedit, it is placed again whenever the grid changes or resizes while composing, so
 * output that moves the cursor (the echo of a key typed just before) takes the preedit with it.
 */
export function usePreedit(wt: WTerm | null): void {
  useEffect(() => {
    if (wt === null) return undefined;
    const element = wt.element;
    const input = element.querySelector("textarea");
    if (input === null) return undefined;
    const grid = element.querySelector(".term-grid") ?? element;
    const widths = new CodepointWidths();
    let shown: HTMLElement | null = null;
    let generation = 0;
    let composing = "";
    let frame = 0;
    const replace = (): void => {
      if (composing === "" || frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (composing !== "") void draw(composing);
      });
    };
    // The preedit is appended outside the grid, so drawing it does not wake these.
    const changed = new MutationObserver(replace);
    const resized = new ResizeObserver(replace);
    const clear = (): void => {
      generation += 1;
      composing = "";
      cancelAnimationFrame(frame);
      frame = 0;
      changed.disconnect();
      resized.disconnect();
      shown?.remove();
      shown = null;
      delete element.dataset["preedit"];
    };
    const draw = async (text: string): Promise<void> => {
      const mine = (generation += 1);
      const codepoints = await widths.of(text);
      const bridge = wt.bridge;
      const first = element.querySelector<HTMLElement>(".term-row:not(.term-scrollback-row)");
      if (mine !== generation || bridge === null || first === null) return;
      const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
      if (!(cell > 0)) return;
      const cols = bridge.getCols();
      const cursor = bridge.getCursor();
      const range = preeditRange(codepoints, Math.min(cursor.col, cols - 1), cols - 1);
      const drawn = codepoints.slice(range.offset);
      const host = element.getBoundingClientRect();
      const origin = first.getBoundingClientRect();
      const left = `${origin.left - host.left - element.clientLeft + element.scrollLeft + range.start * cell}px`;
      const top = `${origin.top - host.top - element.clientTop + element.scrollTop + cursor.row * origin.height}px`;
      // One element for the whole composition, changed in place: each grid change places it again.
      if (shown === null) {
        shown = element.ownerDocument.createElement("div");
        shown.className = "term-row term-preedit";
        shown.setAttribute("aria-hidden", "true");
        element.dataset["preedit"] = "";
        element.appendChild(shown);
      }
      if (shown.textContent !== drawn.map((each) => each.text).join("")) {
        shown.replaceChildren(...preeditCells(element, drawn));
      }
      if (shown.style.left !== left) shown.style.left = left;
      if (shown.style.top !== top) shown.style.top = top;
    };
    const onUpdate = (event: CompositionEvent): void => {
      if (event.data === "") {
        clear();
        return;
      }
      if (composing === "") {
        changed.observe(grid, { childList: true, subtree: true, characterData: true, attributes: true });
        resized.observe(element);
      }
      composing = event.data;
      void draw(composing);
    };
    input.addEventListener("compositionupdate", onUpdate);
    input.addEventListener("compositionend", clear);
    input.addEventListener("blur", clear);
    return () => {
      input.removeEventListener("compositionupdate", onUpdate);
      input.removeEventListener("compositionend", clear);
      input.removeEventListener("blur", clear);
      clear();
      widths.dispose();
    };
  }, [wt]);
}
