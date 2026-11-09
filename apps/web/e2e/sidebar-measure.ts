import type { Locator, Page } from "@playwright/test";

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
 * Waits for the sidebar's width to finish easing (a new --sidebar-width eases like a drag does), then two frames, so a
 * ResizeObserver has reported and any refit has been laid out.
 */
export const settle = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const aside = document.querySelector("aside");
    await Promise.all((aside?.getAnimations() ?? []).map((animation) => animation.finished));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

/**
 * How many characters of `title` are still drawn before the element's ellipsis, in graphemes, from the layout: a
 * character counts when it ends where the ellipsis starts. Text before the title (a separator) is not counted.
 */
export const visibleCharacters = (part: Locator, title: string) =>
  part.evaluate((element, wanted) => {
    const style = getComputedStyle(element);
    const pen = document.createElement("canvas").getContext("2d");
    if (pen !== null) pen.font = style.font;
    const range = document.createRange();
    range.selectNodeContents(element);
    // Overflow is fractional, and measured by width rather than by right edges: sub-pixel positioning can start the text
    // one layout unit before the content edge, so an exact fit can end one unit past it. A line is cut when its layout
    // width runs more than one unit (1/64 px) past the content width, which scrollWidth and clientWidth both round away.
    const rect = element.getBoundingClientRect();
    const contentWidth =
      rect.width -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight) -
      Number.parseFloat(style.borderLeftWidth) -
      Number.parseFloat(style.borderRightWidth);
    const contentRight = rect.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);
    const cut = range.getBoundingClientRect().width > contentWidth + 1 / 64;
    const ellipsis = cut && pen !== null ? pen.measureText("\u2026").width : 0;
    const end = contentRight - ellipsis;
    const segmenter = new Intl.Segmenter();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode() !== null) if (walker.currentNode instanceof Text) nodes.push(walker.currentNode);
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
    // Chromium lays text out at 1/64 px, so a glyph ending within one unit of the ellipsis is still the last one drawn
    // (a name the row's flex shrank by a hundredth of a pixel keeps its last glyph); past that, the ellipsis hides it.
    const drawn = rights.filter((right) => right <= end + 1 / 64).length;
    return { visible: Math.max(0, drawn - before), total: [...segmenter.segment(wanted)].length };
  }, title);
