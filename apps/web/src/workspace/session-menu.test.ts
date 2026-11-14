import { afterEach, expect, test } from "bun:test";
import { menuReturnsFocus } from "./session-menu.tsx";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
  else Object.defineProperty(globalThis, "document", originalDocument);
});

// The focus policy reads the browser's current focus and modal presence when an exit finishes.
const menu = { closest: () => menu };
const terminal = { closest: () => null };
const button = { closest: () => null };
const body = { closest: () => null };

test.each([
  ["the closing menu still has focus", menu, false, true],
  ["the focused menu item was removed", body, false, true],
  ["nothing has focus", null, false, true],
  ["the terminal took focus after Cancel", terminal, false, false],
  ["another control took focus", button, false, false],
  ["a modal is open while focus is between layers", body, true, false],
  ["a modal is open while the menu still has focus", menu, true, false],
] as const)("session menu focus return: %s", (_name, activeElement, modal, expected) => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body, activeElement, querySelector: () => (modal ? {} : null) },
  });
  expect(menuReturnsFocus()).toBe(expected);
});
