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
 * Reads a point again while the rows it is measured on are rebuilt under it: a layout change (the keys panel leaving,
 * a refit) remounts the rows, and with WebGL drawing their text comes back a moment after the pixels (#2810).
 */
async function retried<T extends object>(read: () => Promise<T>): Promise<T> {
  const got: T[] = [];
  await expect(async () => {
    got.splice(0, got.length, await read());
  }).toPass();
  const [value] = got;
  if (value === undefined) throw new Error("the point was never read");
  return value;
}

/** A screen's lines with trailing blanks dropped, as the page and the core each pad them differently. */
const lines = (text: string): string[] => {
  const all = text.split("\n").map((line) => line.replace(/[\s\u00a0]+$/u, ""));
  while (all.at(-1) === "") all.pop();
  return all;
};

/**
 * Waits until the terminal's rows in the page hold what its last frame showed. With WebGL drawing (#2810) the rows'
 * text, and the history's height with it, catch up once output goes quiet or a finger lands; a spec that measures the
 * page (a scroll offset, a row's box) before that measures a page still catching up. Instant for the DOM renderer.
 */
export async function textCaughtUp(terminal: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const { drawn, shown } = await terminal.evaluate((root) => {
        const address = root.getAttribute("data-terminal") ?? "";
        const screens = Reflect.get(window, "__dorifaceTerminalScreens") as Record<string, () => string> | undefined;
        const live = [...root.querySelectorAll(".term-row:not(.term-scrollback-row)")];
        return { drawn: screens?.[address]?.() ?? null, shown: live.map((row) => row.textContent ?? "").join("\n") };
      });
      return drawn === null || lines(drawn).join("\n") === lines(shown).join("\n");
    })
    .toBe(true);
}

/**
 * The middle of `needle`'s first appearance on the terminal row that holds `row`, in page px, once the row has stopped
 * moving and a caret at that point still reads the same word: the terminal follows its output, and a point measured
 * while it does lands somewhere else by the time a finger presses it.
 */
export async function pointOn(terminal: Locator, row: string, needle: string): Promise<TouchPoint> {
  await rowShown(terminal, row);
  return retried(() =>
    terminal.evaluate(
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
    ),
  );
}

/** A point inside the first word of `row`, far enough from both edges that a finger lands on the text. */
export async function pointOnRowStart(terminal: Locator, row: string): Promise<TouchPoint> {
  await rowShown(terminal, row);
  return retried(() =>
    terminal.evaluate((root, wanted) => {
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
    }, row),
  );
}

/** A point past `row`'s last text, where a drag to the end of the line lands. */
export async function rowEnd(terminal: Locator, row: string): Promise<TouchPoint> {
  await rowShown(terminal, row);
  return retried(() =>
    terminal.evaluate((root, wanted) => {
      const line = [...root.querySelectorAll(".term-row")].find(
        (candidate) => candidate.textContent?.includes(wanted) === true,
      );
      if (line === undefined) throw new Error(`no row holds ${wanted}`);
      const box = line.getBoundingClientRect();
      return { x: box.right - 4, y: box.top + box.height / 2 };
    }, row),
  );
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
