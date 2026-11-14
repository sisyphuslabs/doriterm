import { afterEach, expect, test } from "bun:test";
import { menuReturnsFocus } from "./session-menu.tsx";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
  else Object.defineProperty(globalThis, "document", originalDocument);
});

// The focus policy reads the browser's current focus and modal presence when an exit finishes. Focus inside a menu
// popup: `closest('[role="menu"]')` answers that popup, which Base UI marks data-open until its close has begun.
const popup = (open: boolean) => {
  const element = { closest: () => element, hasAttribute: (name: string) => open && name === "data-open" };
  return element;
};
const closing = popup(false);
const removedWhileOpen = popup(true);
const otherOpenMenu = popup(true);
const terminal = { closest: () => null };
const button = { closest: () => null };
const body = { closest: () => null };

test.each([
  ["the closing menu still has focus", closing, closing, false, true],
  ["the menu is removed while open and still has focus", removedWhileOpen, removedWhileOpen, false, true],
  ["the focused menu item was removed", body, closing, false, true],
  ["nothing has focus", null, closing, false, true],
  ["the terminal took focus after Cancel", terminal, closing, false, false],
  ["another control took focus", button, closing, false, false],
  ["another menu opened meanwhile has focus", otherOpenMenu, closing, false, false],
  ["a modal is open while focus is between layers", body, closing, true, false],
  ["a modal is open while the menu still has focus", closing, closing, true, false],
] as const)("session menu focus return: %s", (_name, activeElement, own, modal, expected) => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body, activeElement, querySelector: () => (modal ? {} : null) },
  });
  expect(menuReturnsFocus(own as unknown as Element)).toBe(expected);
});
