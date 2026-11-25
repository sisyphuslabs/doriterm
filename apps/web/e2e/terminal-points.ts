import type { Locator } from "@playwright/test";
import { expect } from "./fixtures.ts";
import type { TouchPoint } from "./touch.ts";

/**
 * Waits until a row of the terminal holds `row` in the page: a terminal drawn with WebGL paints the pixels first and
 * brings its rows' text current a moment later (#2810), and every point below is measured on that text.
 */
const rowShown = (terminal: Locator, row: string) =>
  expect(terminal.locator(".term-row", { hasText: row }).first()).toBeAttached();

/**
 * The middle of `needle`'s first appearance on the terminal row that holds `row`, in page px, once the row has stopped
 * moving and a caret at that point still reads the same word: the terminal follows its output, and a point measured
 * while it does lands somewhere else by the time a finger presses it.
 */
export async function pointOn(terminal: Locator, row: string, needle: string): Promise<TouchPoint> {
  await rowShown(terminal, row);
  return terminal.evaluate(
    async (root, [wanted, text]) => {
      const rowOf = (): Element | undefined =>
        [...root.querySelectorAll(".term-row")].find((candidate) => candidate.textContent?.includes(wanted) === true);
      const boxOf = (): { readonly point: TouchPoint; readonly at: number; readonly node: Text } | null => {
        const line = rowOf();
        if (line === undefined) return null;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (!(node instanceof Text)) continue;
          const at = node.data.indexOf(text);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const box = range.getBoundingClientRect();
          return { point: { x: box.left + box.width / 2, y: box.top + box.height / 2 }, at, node };
        }
        return null;
      };
      /** What the app's own hit test finds at `point` is this word. */
      const holds = (found: { readonly point: TouchPoint; readonly at: number; readonly node: Text }): boolean => {
        const range = document.caretRangeFromPoint(found.point.x, found.point.y);
        if (range === null || range.startContainer !== found.node) return false;
        return range.startOffset >= found.at && range.startOffset <= found.at + text.length;
      };
      let found = boxOf();
      if (found === null) throw new Error(`no row holds ${wanted}`);
      for (let attempt = 0; attempt < 40; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- each attempt measures the row after the frame it waited for
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const next = boxOf();
        if (next === null) throw new Error(`no row holds ${wanted}`);
        const still = Math.abs(next.point.x - found.point.x) < 0.5 && Math.abs(next.point.y - found.point.y) < 0.5;
        if (still && holds(next)) return next.point;
        found = next;
      }
      const at = document.elementFromPoint(found.point.x, found.point.y);
      const caret = document.caretRangeFromPoint(found.point.x, found.point.y);
      throw new Error(
        `the point over ${text} (${Math.round(found.point.x)},${Math.round(found.point.y)}) holds ` +
          `${at?.nodeName ?? "nothing"}.${at?.className ?? ""}, and a caret there reads ` +
          `${caret?.startContainer.nodeName ?? "none"}/${caret?.startOffset ?? -1}`,
      );
    },
    [row, needle] as const,
  );
}

/** A point inside the first word of `row`, far enough from both edges that a finger lands on the text. */
export async function pointOnRowStart(terminal: Locator, row: string): Promise<TouchPoint> {
  await rowShown(terminal, row);
  return terminal.evaluate((root, wanted) => {
    const line = [...root.querySelectorAll(".term-row")].find(
      (candidate) => candidate.textContent?.includes(wanted) === true,
    );
    if (line === undefined) throw new Error(`no row holds ${wanted}`);
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text) || node.data.trim() === "") continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(node.data.length, 3));
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    throw new Error(`${wanted} has no text`);
  }, row);
}

/** A point past `row`'s last text, where a drag to the end of the line lands. */
export async function rowEnd(terminal: Locator, row: string): Promise<TouchPoint> {
  await rowShown(terminal, row);
  return terminal.evaluate((root, wanted) => {
    const line = [...root.querySelectorAll(".term-row")].find(
      (candidate) => candidate.textContent?.includes(wanted) === true,
    );
    if (line === undefined) throw new Error(`no row holds ${wanted}`);
    const box = line.getBoundingClientRect();
    return { x: box.right - 4, y: box.top + box.height / 2 };
  }, row);
}

/** The middle of the last row that has text in it: a place to press whatever the screen is showing. */
export async function pointOnLastText(terminal: Locator): Promise<TouchPoint> {
  return terminal.evaluate((root) => {
    const rows = [...root.querySelectorAll(".term-row")].filter((row) => (row.textContent ?? "").trim() !== "");
    const line = rows.at(-1);
    if (line === undefined) throw new Error("the terminal has no text");
    const range = document.createRange();
    range.selectNodeContents(line);
    const box = range.getBoundingClientRect();
    return { x: box.left + Math.min(24, box.width / 2), y: box.top + box.height / 2 };
  });
}
