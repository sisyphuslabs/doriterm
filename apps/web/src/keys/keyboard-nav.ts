/**
 * Tracks genuine UI keyboard navigation (`Tab` outside a terminal) on `<html>` via `data-keyboard-nav`.
 *
 * Chromium matches `:focus-visible` on text inputs even on mouse clicks or programmatic focus (Command Palette,
 * Find bar, Settings search), and on buttons/tabs whenever the user was previously typing in a terminal.
 * Gating focus rings on `data-keyboard-nav` matches native macOS desktop apps: zero stray outlines on clicks,
 * shortcuts, or programmatic focus restoration, while preserving full WCAG focus rings for Tab navigation.
 */
export function startKeyboardNav(root: HTMLElement = document.documentElement, target: Window = window): () => void {
  const enable = (): void => {
    root.dataset["keyboardNav"] = "";
  };
  const disable = (): void => {
    delete root.dataset["keyboardNav"];
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const insideTerminal =
      typeof Element !== "undefined" &&
      event.target instanceof Element &&
      event.target.closest("[data-terminal]") !== null;
    if (insideTerminal) {
      disable();
      return;
    }
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      enable();
    }
  };

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("pointerdown", disable, true);
  target.addEventListener("mousedown", disable, true);
  target.addEventListener("blur", disable);

  return () => {
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("pointerdown", disable, true);
    target.removeEventListener("mousedown", disable, true);
    target.removeEventListener("blur", disable);
    disable();
  };
}
