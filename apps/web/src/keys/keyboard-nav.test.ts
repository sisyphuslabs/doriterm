import { describe, expect, test } from "bun:test";
import { startKeyboardNav } from "./keyboard-nav.ts";

function fakeHost() {
  const listeners = new Map<string, Set<EventListener>>();
  const target = {
    addEventListener(type: string, listener: EventListener) {
      let set = listeners.get(type);
      if (set === undefined) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string, event: Partial<KeyboardEvent> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event as Event);
    },
  };
  const dataset: Record<string, string | undefined> = {};
  const root = { dataset } as unknown as HTMLElement;
  return { root, target };
}

describe("startKeyboardNav", () => {
  test("enables data-keyboard-nav only on unmodified Tab outside a terminal, and clears on pointer/blur", () => {
    const { root, target } = fakeHost();
    const stop = startKeyboardNav(root, target as unknown as Window);

    expect(root.dataset["keyboardNav"]).toBeUndefined();

    // Shortcuts and plain typing do not turn on chrome focus rings.
    target.emit("keydown", { key: "p", metaKey: true, shiftKey: true });
    expect(root.dataset["keyboardNav"]).toBeUndefined();

    // Tab outside a terminal enables keyboard navigation rings.
    target.emit("keydown", { key: "Tab", metaKey: false, ctrlKey: false, altKey: false });
    expect(root.dataset["keyboardNav"]).toBe("");

    // Pointer interaction immediately clears it.
    target.emit("pointerdown");
    expect(root.dataset["keyboardNav"]).toBeUndefined();

    // Re-enable, then blur clears it.
    target.emit("keydown", { key: "Tab", metaKey: false, ctrlKey: false, altKey: false });
    expect(root.dataset["keyboardNav"]).toBe("");
    target.emit("blur");
    expect(root.dataset["keyboardNav"]).toBeUndefined();

    stop();
  });
});
