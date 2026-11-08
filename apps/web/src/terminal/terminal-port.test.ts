import { describe, expect, test } from "bun:test";
import type { TerminalHandle } from "@wterm/react";
import { askingForKeyboard, portOf } from "./terminal-port.ts";

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

  test("a focused field that already asks for the keyboard keeps its focus: nothing is let go", () => {
    const { handle, field, order } = withField(true);
    field.inputMode = "text";
    askingForKeyboard(handle, true);
    expect(order).toEqual([]);
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
