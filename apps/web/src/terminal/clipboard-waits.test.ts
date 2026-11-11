import { describe, expect, test } from "bun:test";
import { ClipboardWaits, type WaitNotices } from "./clipboard-waits.ts";
import type { TerminalInput } from "./terminal-view-props.ts";

/**
 * The notices shown and closed, by id, and a view's writes. Every close is recorded, an id-less one included: the toast
 * manager reads close() with no id as "close every toast", so a view must never make one. Every closed assertion below
 * is toStrictEqual, because toEqual reads an undefined entry as absent ([undefined] as [], ["n1", undefined] as
 * ["n1"]) and would hide exactly that call (#2359).
 */
function view() {
  const shown: string[] = [];
  const closed: (string | undefined)[] = [];
  const notices: WaitNotices = {
    add: () => {
      const id = `n${shown.length + 1}`;
      shown.push(id);
      return id;
    },
    close: (id) => {
      closed.push(id);
    },
  };
  const sent: TerminalInput[] = [];
  const pasted: File[] = [];
  const waits = new ClipboardWaits(() => notices);
  const press = () =>
    waits.press({
      later: () => undefined,
      send: (data) => sent.push(data),
      pasteFiles: (files) => pasted.push(...files),
    });
  return { shown, closed, sent, pasted, waits, press };
}

describe("ClipboardWaits: Paste image's notice and late answers, per view (#1938)", () => {
  test("a second press while one waits adds no second notice; it closes once neither waits", () => {
    const one = view();
    const first = one.press();
    const second = one.press();
    first.waiting?.(true);
    second.waiting?.(true);
    expect(one.shown).toEqual(["n1"]);
    first.waiting?.(false);
    expect(one.closed).toStrictEqual([]);
    second.waiting?.(false);
    expect(one.closed).toStrictEqual(["n1"]);
  });

  test("a view gone or left closes the notice, and the late ^V or image path is dropped", () => {
    const one = view();
    const waiting = one.press();
    const image = one.press();
    waiting.waiting?.(true);
    image.waiting?.(true);
    one.waits.end();
    expect(one.closed).toStrictEqual(["n1"]);
    waiting.waiting?.(false);
    waiting.send("\u0016");
    image.waiting?.(false);
    image.pasteFiles([new File(["x"], "image.png", { type: "image/png" })]);
    expect(one.sent).toEqual([]);
    expect(one.pasted).toEqual([]);
    expect(one.closed).toStrictEqual(["n1"]);
  });

  test("a press after the view comes back is heard as usual, with a notice of its own", () => {
    const one = view();
    one.press().waiting?.(true);
    one.waits.end();
    const again = one.press();
    again.waiting?.(true);
    expect(one.shown).toEqual(["n1", "n2"]);
    again.waiting?.(false);
    again.send("\u0016");
    expect(one.sent).toEqual(["\u0016"]);
    expect(one.closed).toStrictEqual(["n1", "n2"]);
  });

  test("ending with nothing waiting closes nothing", () => {
    const one = view();
    one.waits.end();
    expect(one.closed).toStrictEqual([]);
  });
});
