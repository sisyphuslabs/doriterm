import type { Locator } from "@playwright/test";

/** A sidebar list's rows: its buttons that are not a row's labelled action (Pin, More, New space). */
export const rows = (scope: Locator): Locator => scope.locator("button:not([aria-label])");

/** How far each row's content runs past the row's right edge, and where its age column ends. */
export const rowEdges = (list: Locator) =>
  list.evaluateAll((buttons) =>
    buttons.map((row) => {
      const box = row.getBoundingClientRect();
      const right = Math.max(...[...row.children].map((child) => child.getBoundingClientRect().right));
      return { overflow: right - box.right, age: row.querySelector("time")?.getBoundingClientRect().right };
    }),
  );

/**
 * How many characters of `title` are still drawn before the element's ellipsis, in graphemes, from the layout: a
 * character counts when it ends left of where the ellipsis starts. Text before the title (a separator) is not counted.
 */
export const visibleCharacters = (part: Locator, title: string) =>
  part.evaluate((element, wanted) => {
    const style = getComputedStyle(element);
    const pen = document.createElement("canvas").getContext("2d");
    if (pen !== null) pen.font = style.font;
    const cut = element.scrollWidth > element.clientWidth;
    const ellipsis = cut && pen !== null ? pen.measureText("\u2026").width : 0;
    const end = element.getBoundingClientRect().right - Number.parseFloat(style.paddingRight) - ellipsis;
    const segmenter = new Intl.Segmenter();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode() !== null) if (walker.currentNode instanceof Text) nodes.push(walker.currentNode);
    const range = document.createRange();
    const rights = nodes.flatMap((node) =>
      [...segmenter.segment(node.data)].map(({ index, segment }) => {
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        return range.getBoundingClientRect().right;
      }),
    );
    const all = element.textContent ?? "";
    const lead = all.indexOf(wanted);
    if (lead === -1) return { visible: 0, total: [...segmenter.segment(wanted)].length };
    const before = [...segmenter.segment(all.slice(0, lead))].length;
    // Both edges are fractional: half a pixel either way is subpixel positioning, not a character cut off (a name the
    // row's flex shrank by a hundredth of a pixel still draws its last glyph).
    const drawn = rights.filter((right) => right <= end + 0.5).length;
    return { visible: Math.max(0, drawn - before), total: [...segmenter.segment(wanted)].length };
  }, title);
