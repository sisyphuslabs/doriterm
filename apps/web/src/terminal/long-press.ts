/**
 * What a held touch over the terminal selects (#664): the word under the finger, then whatever a drag reaches. Ghostty
 * selects by words on a double click over its cells; here the same cells are DOM nodes, so the selection is a DOM
 * range over them: the app's own cell layer paints it (use-selection-cells.ts) and copy takes its text.
 *
 * The caret comes from the row's own geometry rather than from `caretRangeFromPoint`, because the renderer's input
 * textarea sits over the cell the cursor is in: a press there hit-tests the textarea, and its caret says nothing about
 * the terminal's text. A row and a character in it are what a press and a drag both need, and they survive redraws.
 */

const ROW = ".term-row";

/** How long a touch stays put before it asks for the text under it rather than a tap or a scroll. */
export const LONG_PRESS_MS = 450;
/** How far a touch may travel first: past this it is a scroll, or a tap that moved, and no word is selected. */
export const LONG_PRESS_SLOP = 8;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A character in one of the terminal's rows. */
export interface Caret {
  readonly row: HTMLElement;
  readonly index: number;
}

/** A word, as the two carets that bound it. */
export interface Word {
  readonly start: Caret;
  readonly end: Caret;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function textNodes(row: HTMLElement): Text[] {
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) nodes.push(node);
  }
  return nodes;
}

const rowsOf = (doc: Document): HTMLElement[] => [...doc.querySelectorAll<HTMLElement>(ROW)];

/** The row the point is on, or the nearest one when it is between rows or past the text. */
function rowAt(doc: Document, at: Point): HTMLElement | null {
  let best: HTMLElement | null = null;
  let nearest = Number.POSITIVE_INFINITY;
  for (const row of rowsOf(doc)) {
    const box = row.getBoundingClientRect();
    if (box.height <= 0) continue;
    const away = at.y < box.top ? box.top - at.y : at.y > box.bottom ? at.y - box.bottom : 0;
    if (away < nearest) {
      nearest = away;
      best = row;
    }
    if (away === 0) break;
  }
  return best;
}

/** The character `x` falls on in `row`: the one whose own box is nearest, measured as the glyphs are drawn. */
function characterAt(row: HTMLElement, x: number): Caret {
  const nodes = textNodes(row);
  const range = row.ownerDocument.createRange();
  let index = 0;
  let best = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    for (let offset = 0; offset < node.data.length; offset++) {
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const box = range.getBoundingClientRect();
      const middle = box.left + box.width / 2;
      const away = Math.abs(middle - x);
      if (away < nearest) {
        nearest = away;
        best = index + offset;
      }
      if (middle > x) break;
    }
    index += node.data.length;
  }
  return { row, index: best };
}

export function caretAt(doc: Document, at: Point): Caret | null {
  const row = rowAt(doc, at);
  return row === null ? null : characterAt(row, at.x);
}

const wholeText = (row: HTMLElement): string =>
  textNodes(row)
    .map((node) => node.data)
    .join("");

/** The text node and offset `index` characters into `row`, clamped to its end. */
function positionIn(row: HTMLElement, index: number): { readonly node: Text; readonly offset: number } | null {
  const nodes = textNodes(row);
  let left = Math.max(0, index);
  for (const node of nodes) {
    if (left <= node.data.length) return { node, offset: left };
    left -= node.data.length;
  }
  const last = nodes.at(-1);
  return last === undefined ? null : { node: last, offset: last.data.length };
}

function rangeOf(doc: Document, from: Caret, to: Caret): Range | null {
  const start = positionIn(from.row, from.index);
  const end = positionIn(to.row, to.index);
  if (start === null || end === null) return null;
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/** Whether `a` comes before `b` in the terminal's text. */
const before = (a: Caret, b: Caret): boolean => {
  if (a.row === b.row) return a.index < b.index;
  return (a.row.compareDocumentPosition(b.row) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
};

/**
 * The word under `at`: the word a text field would select there, its punctuation left out, and one character when it
 * landed on spacing. Null when the point holds no terminal text.
 */
export function wordRangeAt(doc: Document, at: Point): { readonly range: Range; readonly word: Word } | null {
  const caret = caretAt(doc, at);
  if (caret === null) return null;
  const text = wholeText(caret.row);
  let start = caret.index;
  let end = caret.index;
  for (const segment of segmenter.segment(text)) {
    if (caret.index < segment.index) break;
    if (caret.index >= segment.index + segment.segment.length) continue;
    const word = segment.isWordLike === true;
    start = word ? segment.index : caret.index;
    end = word ? segment.index + segment.segment.length : Math.min(text.length, caret.index + 1);
    break;
  }
  if (end <= start) {
    start = Math.min(caret.index, Math.max(0, text.length - 1));
    end = Math.min(text.length, start + 1);
  }
  const word = { start: { row: caret.row, index: start }, end: { row: caret.row, index: end } };
  const range = rangeOf(doc, word.start, word.end);
  return range === null ? null : { range, word };
}

/**
 * The held word plus what a drag has reached: from the word's start to the finger when the finger is past it, from the
 * finger to the word's end when it is before, and the word itself while the drag is still on it.
 */
export function extendSelection(doc: Document, word: Word, at: Caret): Range | null {
  if (!before(at, word.end)) return rangeOf(doc, word.start, at);
  if (before(at, word.start)) return rangeOf(doc, at, word.end);
  return rangeOf(doc, word.start, word.end);
}

const pressed = new WeakSet<Element>();

/**
 * Says the touch now on `element` picked text, so the tap its own lift would make is not one. The browser sends that
 * touch's mouse events a few milliseconds after its lift, however long the finger stayed down, so the mark outlives the
 * lift instead of expiring after a window measured from the pick: a finger that dwells on the selection is still a hold.
 */
export function markLongPress(element: Element): void {
  pressed.add(element);
}

/** Whether the touch now on `element` picked text. */
export function longPressed(element: Element): boolean {
  return pressed.has(element);
}

/** Begins a press on `element`: what the last touch did there does not speak for this one. */
export function clearLongPress(element: Element): void {
  pressed.delete(element);
}
