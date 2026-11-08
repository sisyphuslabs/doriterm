/** What an open modal leaves behind it: a Base UI dialog or alert dialog marks the rest of the page aria-hidden. */
const BEHIND_MODAL = '[aria-hidden="true"], [inert]';
/**
 * Layers that hold the keyboard while open: dialogs and alert dialogs (the palette is a dialog too), menus, which
 * Base UI opens without hiding the page, and a field edited in place (`data-holds-keyboard`, a space's name).
 */
const LAYERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-holds-keyboard]';
/** A terminal on a touch screen whose soft keyboard the person has not asked for (TerminalViewProps.softKeyboard). */
const KEYBOARD_UNASKED = '[data-soft-keyboard="unasked"]';

/** Whether a focus in `terminal` would raise a soft keyboard nobody asked for (#1375): it takes none on its own. */
export function keyboardUnasked(terminal: HTMLElement): boolean {
  return terminal.closest(KEYBOARD_UNASKED) !== null;
}

/**
 * Whether a terminal may move keyboard focus into itself on its own: as its renderer starts, its stream attaches, its
 * pane becomes the focused one, or a press that started on it ends.
 * Never while a modal is open over it: focus would leave the open question, Esc would no longer reach it, and keys
 * typed next would go to the program behind it. Never on a touch screen until the person asks for the keyboard.
 */
export function mayTakeFocus(terminal: HTMLElement): boolean {
  if (terminal.closest(BEHIND_MODAL) !== null || keyboardUnasked(terminal)) return false;
  const active = terminal.ownerDocument.activeElement;
  return active === null || terminal.contains(active) || active.closest(LAYERS) === null;
}

/**
 * Whether the keyboard is nowhere a terminal starting on its own would take it from: on no element, the page itself
 * (where it lands when the focused terminal's view goes away), or inside `terminal` already.
 */
export function keyboardIsIdle(terminal: HTMLElement): boolean {
  const active = terminal.ownerDocument.activeElement;
  return active === null || active === terminal.ownerDocument.body || terminal.contains(active);
}
