import { describe, expect, test } from "bun:test";
import type { TerminalHandle } from "@wterm/react";
import { isRegainingReport, portOf, regainingFocus } from "./terminal-port.ts";

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
  const listeners = new Map<string, (event: unknown) => void>();
  const defaultView = {
    addEventListener: (type: string, listener: (event: unknown) => void): void => void listeners.set(type, listener),
    removeEventListener: (type: string, listener: (event: unknown) => void): void => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  // What lies under a point, as the pointer lifts: the pressed button at (1, 1), anything else elsewhere.
  const button = { contains: (node: unknown): boolean => node === button };
  const elsewhere = {};
  const field = {
    inputMode,
    isConnected: true,
    ownerDocument: {
      activeElement: null as unknown,
      defaultView,
      elementFromPoint: (x: number, y: number): unknown => (x === 1 && y === 1 ? button : elsewhere),
    },
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
  const handle: { current: TerminalHandle | null } = { current: { instance, focus } as unknown as TerminalHandle };
  const send = (data: unknown): void => void order.push(`send:${String(data)}`);
  return {
    port: portOf(handle, send, () => undefined, true),
    handle,
    field,
    order,
    listeners,
    button: button as unknown as Element,
  };
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
    const { port, handle, field, order, listeners, button } = phoneField(true, "none", "");
    port.letGo(button);
    expect(order).toEqual(["blur:none"]);
    // Between the press's pointerdown and its click the field is still the port's own, and no scroll ends the press:
    // the terminal scrolls itself while it follows output.
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(true);
    expect([...listeners.keys()].toSorted()).toEqual(["click", "pointercancel", "pointerup"]);
    listeners.get("pointerup")?.({ clientX: 1, clientY: 1 });
    expect(regainingFocus(field as unknown as EventTarget)).toBe(true);
    port.focus();
    expect(order).toEqual(["blur:none", "focus:text"]);
    expect(listeners.size).toBe(0);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
    expect(isRegainingReport(handle, "\x1b[I")).toBe(false);
  });

  test("a cancelled tap: the field gets its focus back in the mode it had, unseen by the program, and the hold ends", async () => {
    const { port, field, order, listeners, button } = phoneField(true, "none", "");
    port.letGo(button);
    listeners.get("pointercancel")?.({});
    expect(order).toEqual(["blur:none", "focus:none"]);
    expect(field.ownerDocument.activeElement).toBe(field);
    expect(listeners.size).toBe(0);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
    // A later click asks for the keyboard as a press with no hold does.
    port.focus();
    expect(order).toEqual(["blur:none", "focus:none", "blur:none", "focus:text"]);
  });

  test("a press that lifts off its button gives the field back at once, unseen by the program", async () => {
    const { port, field, order, listeners, button } = phoneField(true, "none", "");
    port.letGo(button);
    listeners.get("pointerup")?.({ clientX: 40, clientY: 40 });
    expect(order).toEqual(["blur:none", "focus:none"]);
    expect(listeners.size).toBe(0);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
  });

  test("a click that lands on another element ends the hold the same way", async () => {
    const { port, field, order, listeners, button } = phoneField(true, "none", "");
    port.letGo(button);
    listeners.get("click")?.({});
    expect(order).toEqual(["blur:none", "focus:none"]);
    expect(listeners.size).toBe(0);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
  });

  test("another pointer lifting or cancelled during the press is not its end: the hold stays until its own click (#2048)", async () => {
    const { port, field, order, listeners, button } = phoneField(true, "none", "");
    port.letGo(button, 1);
    listeners.get("pointerup")?.({ clientX: 40, clientY: 40, pointerId: 2 });
    listeners.get("pointercancel")?.({ pointerId: 2 });
    expect(order).toEqual(["blur:none"]);
    expect([...listeners.keys()].toSorted()).toEqual(["click", "pointercancel", "pointerup"]);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(true);
    // The press's own pointer lifting off its button still gives the field back.
    listeners.get("pointerup")?.({ clientX: 40, clientY: 40, pointerId: 1 });
    expect(order).toEqual(["blur:none", "focus:none"]);
    expect(listeners.size).toBe(0);
  });

  test("a port torn down mid-press, its pane gone, leaves no listener on the window and no field marked (#2048)", async () => {
    const { port, handle, field, order, listeners, button } = phoneField(true, "none", "");
    port.letGo(button, 1);
    field.isConnected = false;
    handle.current = null;
    port.dispose();
    expect(listeners.size).toBe(0);
    expect(order).toEqual(["blur:none"]);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
  });

  test("a port replaced mid-press while its field stays gives the field its focus back, unseen by the program (#2048)", async () => {
    const { port, field, order, listeners, button } = phoneField(true, "none", "");
    port.letGo(button, 1);
    port.dispose();
    expect(order).toEqual(["blur:none", "focus:none"]);
    expect(field.ownerDocument.activeElement).toBe(field);
    expect(listeners.size).toBe(0);
    await Promise.resolve();
    expect(regainingFocus(field as unknown as EventTarget)).toBe(false);
  });

  test("a port torn down after its press ended leaves the field alone", () => {
    const { port, order, listeners, button } = phoneField(true, "none", "");
    port.letGo(button, 1);
    port.focus();
    port.dispose();
    expect(order).toEqual(["blur:none", "focus:text"]);
    expect(listeners.size).toBe(0);
  });
});
