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
  const field = {
    inputMode,
    ownerDocument: { activeElement: null as unknown },
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
  return { port: portOf(handle, send, () => undefined, true), handle, field, order };
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
