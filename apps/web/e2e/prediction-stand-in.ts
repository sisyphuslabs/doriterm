import type { Page } from "@playwright/test";

/**
 * Call before page.goto: a stand-in predictor behind the overlay's test hook (`window.__dorifacePredict`, removed with
 * the real predictor's wiring), shaped as the overlay's contract asks of the real one (#1430):
 * - `visible()` is the unconfirmed tail in typing order; a cell leaves it at the write that echoes it (the real cursor
 *   passes it with its text in place), synchronously
 *   (mosh's Correct, terminaloverlay.cc:546-549), and the overlay decides when that removal is painted;
 * - every change is announced synchronously.
 * Cells come from `__predictor.add`, or, once `__predictor.typing(true)`, from each printable key and each committed
 * composition, as the view's input path will feed it. `__afterHostMessage(data)`, when set, runs right after the app's
 * own handler for each host message, inside that message's task.
 */
export async function installPredictor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Cell {
      row: number;
      col: number;
      text: string;
      width: 1 | 2;
    }
    interface Screen {
      cursor(): { row: number; col: number };
      cell(row: number, col: number): string;
      onWrite?: (listener: () => void) => () => void;
    }
    const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/u;
    Reflect.set(window, "__dorifacePredict", (screen: Screen) => {
      const cells: Cell[] = [];
      const listeners = new Set<() => void>();
      let typing = false;
      const changed = (): void => {
        for (const listener of listeners) listener();
      };
      const add = (text: string, width: 1 | 2): Cell => {
        const cursor = screen.cursor();
        const last = cells.at(-1);
        const col = last !== undefined && last.row === cursor.row ? last.col + last.width : cursor.col;
        const cell = { row: cursor.row, col, text, width };
        cells.push(cell);
        changed();
        return cell;
      };
      // A cell is confirmed only once the real cursor has passed it with its text in place, in typing order. A cell
      // that already held the text before the echo (a blank cell holds " ") is not an echo: confirming it early would
      // place the next key at the lagging real cursor, a column left of where it belongs (#1434 CI, phone).
      screen.onWrite?.(() => {
        const cursor = screen.cursor();
        let confirmed = 0;
        for (const cell of cells) {
          const passed = cursor.row > cell.row || (cursor.row === cell.row && cursor.col >= cell.col + cell.width);
          if (!passed || screen.cell(cell.row, cell.col) !== cell.text) break;
          confirmed += 1;
        }
        if (confirmed === 0) return;
        cells.splice(0, confirmed);
        changed();
      });
      document.addEventListener(
        "keydown",
        (event) => {
          const plain = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
          if (typing && plain && !event.isComposing) add(event.key, 1);
        },
        true,
      );
      document.addEventListener(
        "compositionend",
        (event) => {
          if (typing && event.data !== "") add(event.data, WIDE.test(event.data) ? 2 : 1);
        },
        true,
      );
      Reflect.set(window, "__predictor", {
        add,
        typing: (on: boolean) => void (typing = on),
        cell: (row: number, col: number): string => screen.cell(row, col),
      });
      return {
        visible: () => cells,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    });
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const wrapped = new WeakMap<object, EventListener>();
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type !== "message" || listener === null || !("binaryType" in this))
        return add.call(this, type, listener, options);
      const after = (event: Event): void => {
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
        const hook: unknown = Reflect.get(window, "__afterHostMessage");
        if (typeof hook === "function" && event instanceof MessageEvent) hook(event.data);
      };
      wrapped.set(listener, after);
      return add.call(this, type, after, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      return remove.call(this, type, (listener !== null && wrapped.get(listener)) || listener, options);
    };
  });
}
