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
  readonly #listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }

  listens(type: string): boolean {
    return (this.#listeners.get(type)?.size ?? 0) > 0;
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

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

export interface LongPressTerminal {
  /** What the hook takes from WTerm. */
  readonly wt: { readonly element: Element; readonly focus: () => void };
  /** A finger lands: the document's capture listener runs before the element's, as a browser's does. */
  down(pointerId?: number, primary?: boolean): void;
  /** The finger lifts as pointerup on the window, then that touch's own end; `primary` is false for a second finger. */
  up(pointerId?: number, primary?: boolean): void;
  /** Whether an element listener answers `type` that this pointer dispatched, once the hook's effect is mounted. */
  readonly handled: (type: string) => boolean;
  /** Whether the last `up` was cancelled, so the tap's own mouse events never arrive. */
  readonly tapCancelled: boolean;
  restore(): void;
}

/**
 * One terminal with the word "hello" under the point the harness presses, and a count of the element events its
 * listeners handled: a fresh terminal has no listeners, and the hook's own effect is what gives it the pointerdown and
 * touchend ones.
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
  const count = (type: string): void => {
    handled.set(type, (handled.get(type) ?? 0) + 1);
  };
  element.dispatch = (type: string, event: unknown): void => {
    if (!element.listens(type)) return;
    count(type);
    FakeTarget.prototype.dispatch.call(element, type, event);
  };
  return {
    wt: { element: element as unknown as Element, focus: () => undefined },
    down(pointerId = 1, primary = true): void {
      const event = new FakePointer(pointerId, primary, 25, 10);
      document.dispatch("pointerdown", event);
      element.dispatch("pointerdown", event);
    },
    up(pointerId = 1, primary = true): void {
      window.dispatch("pointerup", new FakePointer(pointerId, primary, 25, 10));
      const touch = new FakeTouch();
      element.dispatch("touchend", touch);
      cancelled = touch.defaultPrevented;
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
