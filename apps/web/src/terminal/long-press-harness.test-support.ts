/**
 * The DOM the long-press hook reads, built by hand because bun has none: one row of text, boxes measured from character
 * offsets, and a window and element whose events the test dispatches. Only `element` and `focus` are what the hook's
 * WTerm needs.
 */

const CHAR_W = 10;
const ROW_H = 20;

function box(left: number, right: number): DOMRect {
  return {
    left,
    right,
    width: right - left,
    top: 0,
    bottom: ROW_H,
    height: ROW_H,
    x: left,
    y: 0,
  } as unknown as DOMRect;
}

class FakeText {
  readonly data: string;
  readonly left: number;
  constructor(data: string, left: number) {
    this.data = data;
    this.left = left;
  }
}

class FakeRange {
  #start: { readonly node: FakeText; readonly offset: number } | null = null;
  #end: { readonly node: FakeText; readonly offset: number } | null = null;

  setStart(node: FakeText, offset: number): void {
    this.#start = { node, offset };
  }

  setEnd(node: FakeText, offset: number): void {
    this.#end = { node, offset };
  }

  toString(): string {
    const start = this.#start;
    const end = this.#end;
    if (start === null || end === null) return "";
    return start.node.data.slice(start.offset, end.offset);
  }

  getBoundingClientRect(): DOMRect {
    const start = this.#start;
    const end = this.#end;
    const from = start?.node.left ?? 0;
    return box(from + (start?.offset ?? 0) * CHAR_W, from + (end?.offset ?? 0) * CHAR_W);
  }
}

class FakeTarget {
  /** As the DOM keys them: a listener added for capture and the same one for bubbling are two listeners (#2339 review). */
  readonly #listeners = new Map<string, { readonly listener: (event: never) => void; readonly capture: boolean }[]>();

  addEventListener(type: string, listener: (event: never) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const listeners = this.#listeners.get(type) ?? [];
    if (!listeners.some((entry) => entry.listener === listener && entry.capture === capture))
      listeners.push({ listener, capture });
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: never) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(
      type,
      listeners.filter((entry) => entry.listener !== listener || entry.capture !== capture),
    );
  }

  dispatch(type: string, event: unknown): void {
    for (const { listener } of this.#listeners.get(type) ?? []) listener(event as never);
  }

  listens(type: string): boolean {
    return (this.#listeners.get(type)?.length ?? 0) > 0;
  }
}

class FakeRow {
  readonly text: FakeText;
  readonly ownerDocument: FakeDocument;
  constructor(ownerDocument: FakeDocument, text: string) {
    this.ownerDocument = ownerDocument;
    this.text = new FakeText(text, 0);
  }

  getBoundingClientRect(): DOMRect {
    return box(0, this.text.data.length * CHAR_W);
  }
}

class FakeDocument extends FakeTarget {
  createTreeWalker(root: FakeRow): { nextNode: () => FakeText | null } {
    let read = false;
    return {
      nextNode: () => {
        if (read) return null;
        read = true;
        return root.text;
      },
    };
  }

  createRange(): FakeRange {
    return new FakeRange();
  }
}

class FakeElement extends FakeTarget {
  readonly ownerDocument: FakeDocument;
  readonly #rows: readonly FakeRow[];
  constructor(ownerDocument: FakeDocument, rows: readonly FakeRow[]) {
    super();
    this.ownerDocument = ownerDocument;
    this.#rows = rows;
  }

  querySelectorAll(selector: string): readonly FakeRow[] {
    return selector === ".term-row" ? this.#rows : [];
  }
}

class FakePointer {
  readonly pointerType = "touch";
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly clientX: number;
  readonly clientY: number;
  constructor(pointerId: number, primary: boolean, x: number, y: number) {
    this.pointerId = pointerId;
    this.isPrimary = primary;
    this.clientX = x;
    this.clientY = y;
  }
}

class FakeTouch {
  readonly cancelable = true;
  defaultPrevented = false;
  /** The fingers still down once this event happened, as TouchEvent.touches lists them. */
  readonly touches: readonly unknown[];
  readonly target: unknown;
  constructor(fingers: number, target: unknown) {
    this.touches = Array.from({ length: fingers }, () => ({}));
    this.target = target;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

export interface LongPressTerminal {
  /** What the hook takes from WTerm. */
  readonly wt: { readonly element: Element; readonly focus: () => void };
  /**
   * A finger lands: the document's capture listener runs before the element's, as a browser's does, and the element
   * sees the touch begin. With `onRedrawnCell` it lands on a cell in the terminal that the program then redraws away:
   * the browser sends that touch's lift to the cell alone, which no longer passes it on (#2057).
   */
  down(pointerId?: number, primary?: boolean, onRedrawnCell?: boolean): void;
  /** The finger lifts as pointerup on the window, then that touch's own end on the node it landed on. */
  up(pointerId?: number, primary?: boolean): void;
  /** The finger moves: the browser sends the touchmove to the node it landed on. Whether that move was cancelled. */
  move(pointerId?: number): boolean;
  /**
   * Whether a listener on the element, the document or the window answered a `type` event this harness dispatched. A
   * fresh terminal has none, and once the hook is unwired none may be left (#1901).
   */
  readonly handled: (type: string) => boolean;
  /** The finger moves as the window sees it: pointermove. */
  pointerMove(pointerId?: number): void;
  /** The browser takes the touch over (a scroll, a gesture): pointercancel on the window. */
  pointerCancel(pointerId?: number): void;
  /** Whether the last `up` was cancelled, so the tap's own mouse events never arrive. */
  readonly tapCancelled: boolean;
  restore(): void;
}

/**
 * One terminal with the word "hello" under the point the harness presses, and a count of the events a listener on its
 * element, document or window answered: a fresh terminal has no listeners, and the hook's own effect is what gives it
 * the pointerdown, touchstart and pointerup ones.
 */
export function longPressTerminal(): LongPressTerminal {
  const document = new FakeDocument();
  const row = new FakeRow(document, "hello world");
  const element = new FakeElement(document, [row]);
  const window = new FakeTarget();
  const previousWindow = globalThis.window;
  const previousText = globalThis.Text;
  const previousNodeFilter = globalThis.NodeFilter;
  Object.assign(globalThis, { window, Text: FakeText, NodeFilter: { SHOW_TEXT: 4 } });
  const handled = new Map<string, number>();
  let cancelled = false;
  /** The node each finger down landed on, by pointer, which gets that touch's end. */
  const landed = new Map<number, FakeTarget>();
  const count = (type: string): void => {
    handled.set(type, (handled.get(type) ?? 0) + 1);
  };
  for (const target of [element, document, window]) {
    target.dispatch = (type: string, event: unknown): void => {
      if (!target.listens(type)) return;
      count(type);
      FakeTarget.prototype.dispatch.call(target, type, event);
    };
  }
  return {
    wt: { element: element as unknown as Element, focus: () => undefined },
    down(pointerId = 1, primary = true, onRedrawnCell = false): void {
      const event = new FakePointer(pointerId, primary, 25, 10);
      document.dispatch("pointerdown", event);
      element.dispatch("pointerdown", event);
      const target = onRedrawnCell ? new FakeTarget() : element;
      landed.set(pointerId, target);
      element.dispatch("touchstart", new FakeTouch(landed.size, target));
    },
    move(pointerId = 1): boolean {
      const target = landed.get(pointerId) ?? element;
      const touch = new FakeTouch(landed.size, target);
      target.dispatch("touchmove", touch);
      return touch.defaultPrevented;
    },
    up(pointerId = 1, primary = true): void {
      window.dispatch("pointerup", new FakePointer(pointerId, primary, 25, 10));
      const target = landed.get(pointerId) ?? element;
      landed.delete(pointerId);
      const touch = new FakeTouch(landed.size, target);
      target.dispatch("touchend", touch);
      cancelled = touch.defaultPrevented;
    },
    pointerMove(pointerId = 1): void {
      window.dispatch("pointermove", new FakePointer(pointerId, true, 25, 10));
    },
    pointerCancel(pointerId = 1): void {
      window.dispatch("pointercancel", new FakePointer(pointerId, true, 25, 10));
    },
    handled: (type) => (handled.get(type) ?? 0) > 0,
    get tapCancelled(): boolean {
      return cancelled;
    },
    restore(): void {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.assign(globalThis, { window: previousWindow });
      if (previousText === undefined) Reflect.deleteProperty(globalThis, "Text");
      else Object.assign(globalThis, { Text: previousText });
      if (previousNodeFilter === undefined) Reflect.deleteProperty(globalThis, "NodeFilter");
      else Object.assign(globalThis, { NodeFilter: previousNodeFilter });
    },
  };
}
