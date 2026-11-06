import { useEffect, useRef } from "react";
import { sidebarElement, sidebarStop, terminalInput } from "./focus-targets.ts";
import { isUsable } from "./use-overlay-focus.ts";

/**
 * A modal dialog is open: either it has hidden the workspace (the guard overlays use, #33), or it is a modal that
 * leaves the workspace in place, as the command palette does. The chord must not act behind either.
 */
function behindModal(): boolean {
  if (document.querySelector('[aria-modal="true"]') !== null) return true;
  const anchor = sidebarElement() ?? terminalInput();
  return anchor !== null && !isUsable(anchor);
}

/**
 * The way out of a focused terminal without the mouse: from the terminal (or anywhere else) it moves focus to the
 * sidebar's list, showing the sidebar first when it is hidden; from the sidebar it goes back to the terminal. While a
 * modal dialog is open it does nothing, so focus stays in the dialog.
 */
export function useFocusSidebar(shown: boolean, show: () => void): () => void {
  const pending = useRef(false);
  useEffect(() => {
    if (!shown || !pending.current) return;
    pending.current = false;
    sidebarStop()?.focus();
  }, [shown]);
  return () => {
    if (behindModal()) return;
    if (sidebarElement()?.contains(document.activeElement) === true) {
      terminalInput()?.focus();
      return;
    }
    if (shown) {
      sidebarStop()?.focus();
      return;
    }
    pending.current = true;
    show();
  };
}
