import { describe, expect, test } from "bun:test";
import type { TerminalHandle } from "@wterm/react";
import { askingForKeyboard, isRegainingReport, portOf, regainingFocus } from "./terminal-port.ts";

/** A terminal whose field still holds a composing syllable, recording what reaches the program in order. */
function composing(syllable: string) {
  const order: string[] = [];
  let preedit = syllable;
  const instance = {
    takeComposition: () => {
      const taken = preedit;
      preedit = "";
      return taken;
    },
  };
  const handle = { current: { instance } as unknown as TerminalHandle };
  const send = (data: unknown): void => void order.push(`send:${String(data)}`);
  const pasteFiles = (files: readonly File[]): void =>
    void order.push(`files:${files.map((file) => file.name).join(",")}`);
  return { port: portOf(handle, send, pasteFiles, false), order };
}

/** A terminal whose renderer field records the input mode it carried as it was let go. */
function withField(focused: boolean) {
  const order: string[] = [];
  const field = {
    inputMode: "",
    ownerDocument: { activeElement: null as unknown },
    blur: (): void => void order.push(`blur:${field.inputMode}`),
  };
  if (focused) field.ownerDocument.activeElement = field;
  const handle = {
    current: { instance: { element: { querySelector: () => field } } } as unknown as TerminalHandle,
  };
  return { handle, field, order };
}

/** The port over a field, with nothing to send to: what it does to the field is all that is read. */
const portOver = (handle: Parameters<typeof portOf>[0], softKeyboard: boolean) =>
  portOf(
    handle,
    () => undefined,
    () => undefined,
    softKeyboard,
  );

describe("the soft keyboard a focus may raise (#1375)", () => {
  test("on a surface that has one, the field is set to ask for the keyboard", () => {
    const { handle, field, order } = withField(false);
    askingForKeyboard(handle, true);
    expect(field.inputMode).toBe("text");
    expect(order).toEqual([]);
  });

  test("a field that already has the focus is let go first: a browser raises no keyboard for a focus it has", () => {
    const { handle, field, order } = withField(true);
    askingForKeyboard(handle, true);
    expect(order).toEqual(["blur:"]);
    expect(field.inputMode).toBe("text");
  });

  test("a surface with no soft keyboard to raise, and a terminal whose field is not there yet, are left alone", () => {
    const { handle, field, order } = withField(true);
    askingForKeyboard(handle, false);
    expect(field.inputMode).toBe("");
    expect(order).toEqual([]);
    expect(() => askingForKeyboard({ current: null }, true)).not.toThrow();
  });
});

describe("letting the field go ahead of a press that asks for the keyboard (#1940)", () => {
  test("a focused field is let go, in the mode it has: the press's own focus is then a fresh one", () => {
    const { handle, field, order } = withField(true);
    field.inputMode = "none";
    portOver(handle, true).letGo();
    expect(order).toEqual(["blur:none"]);
    expect(field.inputMode).toBe("none");
  });

  test("a field without the focus, and a surface with no soft keyboard, are left alone", () => {
    const unfocused = withField(false);
    portOver(unfocused.handle, true).letGo();
    expect(unfocused.order).toEqual([]);
    const mouse = withField(true);
    portOver(mouse.handle, false).letGo();
    expect(mouse.order).toEqual([]);
  });
});

/**
 * A phone terminal whose field may already have the focus in a mode, with a syllable composing in it. What reaches the
 * program is recorded as the view passes it on: a focus change of the field, as the view reports it and as the renderer
 * writes it (mode 1004), unless the port is only taking the field again.
 */
function phoneField(focused: boolean, inputMode: string, syllable: string) {
  const order: string[] = [];
  let preedit = syllable;
  const reported = (gained: boolean): void => {
    const target = field as unknown as EventTarget;
    if (!regainingFocus(target)) order.push(`program:focus-${gained ? "in" : "out"}`);
    if (!isRegainingReport(handle, gained ? "\x1b[I" : "\x1b[O")) order.push(`program:${gained ? "^[[I" : "^[[O"}`);
  };
  const listeners = new Map<string, () => void>();
  const defaultView = {
    addEventListener: (type: string, listener: () => void): void => void listeners.set(type, listener),
    removeEventListener: (type: string, listener: () => void): void => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const field = {
    inputMode,
    ownerDocument: { activeElement: null as unknown, defaultView },
    blur: (): void => {
      field.ownerDocument.activeElement = null;
      reported(false);
      order.push(`blur:${field.inputMode}`);
    },
  };
  if (focused) field.ownerDocument.activeElement = field;
  const instance = {
    element: { querySelector: () => field },
    takeComposition: () => {
      const taken = preedit;
      preedit = "";
      return taken;
    },
  };
  const focus = (): void => {
    if (field.ownerDocument.activeElement === field) return;
    field.ownerDocument.activeElement = field;
    reported(true);
    order.push(`focus:${field.inputMode}`);
  };
  const handle = { current: { instance, focus } as unknown as TerminalHandle };
  const send = (data: unknown): void => void order.push(`send:${String(data)}`);
  return { port: portOf(handle, send, () => undefined, true), handle, field, order, listeners };
}

describe("Show keyboard on a phone terminal (#1519)", () => {
  test("a field already focused for typing is let go and taken again for the keyboard, unseen by the program, its syllable sent first", async () => {
    const { port, handle, field, order } = phoneField(true, "text", "한");
    port.focus();
    expect(order).toEqual(["send:한", "blur:text", "focus:text"]);
    expect(field.ownerDocument.activeElement).toBe(field);
    // The pass is over once the press is: a later move of the focus is the program's to hear.
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
    expect(isRegainingReport(handle, "\x1b[O")).toBe(false);
  });

  test("a field that asks for no keyboard is let go and taken again in text mode, still unseen by the program", () => {
    const { port, order } = phoneField(true, "none", "");
    port.focus();
    expect(order).toEqual(["blur:none", "focus:text"]);
  });

  test("a field without the focus takes it in text mode, and the program hears it", () => {
    const { port, order } = phoneField(false, "none", "");
    port.focus();
    expect(order).toEqual(["program:focus-in", "program:^[[I", "focus:text"]);
  });
});

describe("a press that lets the field go on its pointerdown and takes it on its click (#1940 with #1519)", () => {
  test("a tap: the program hears neither the pointerdown's blur nor the click's focus, and the hold ends after the click", async () => {
    const { port, handle, field, order, listeners } = phoneField(true, "none", "");
    port.letGo();
    expect(order).toEqual(["blur:none"]);
    // Between the press's pointerdown and its click the field is still the port's own.
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(true);
    expect([...listeners.keys()].toSorted()).toEqual(["pointercancel", "scroll"]);
    port.focus();
    expect(order).toEqual(["blur:none", "focus:text"]);
    expect(listeners.size).toBe(0);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
    expect(isRegainingReport(handle, "\x1b[I")).toBe(false);
  });

  test("a cancelled tap: the field gets its focus back in the mode it had, unseen by the program, and the hold ends", async () => {
    const { port, field, order, listeners } = phoneField(true, "none", "");
    port.letGo();
    listeners.get("pointercancel")?.();
    expect(order).toEqual(["blur:none", "focus:none"]);
    expect(field.ownerDocument.activeElement).toBe(field);
    expect(listeners.size).toBe(0);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
    // A later click asks for the keyboard as a press with no hold does.
    port.focus();
    expect(order).toEqual(["blur:none", "focus:none", "blur:none", "focus:text"]);
  });

  test("a tap that turns into a scroll is released the same way", () => {
    const { port, order, listeners } = phoneField(true, "none", "");
    port.letGo();
    listeners.get("scroll")?.();
    expect(order).toEqual(["blur:none", "focus:none"]);
    expect(listeners.size).toBe(0);
  });
});

describe("the terminal port", () => {
  test("pasting files sends a composing syllable first, so the syllable lands before the pasted path (#827)", () => {
    const { port, order } = composing("한");
    port.pasteFiles([new File([], "shot.png")]);
    expect(order).toEqual(["send:한", "files:shot.png"]);
  });

  test("with nothing composing, pasting files sends only the files", () => {
    const { port, order } = composing("");
    port.pasteFiles([new File([], "shot.png")]);
    expect(order).toEqual(["files:shot.png"]);
  });
});
