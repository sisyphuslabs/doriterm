import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { actionFor, type Scope } from "./actions.ts";
import { resolveKeymap } from "./keymap.ts";
import { useOverrides } from "./keymap-store.ts";
import { TEXT_FIELD_KEEPS } from "./text-field-keys.ts";
import { TERMINAL_KEEPS } from "./terminal-keeps.ts";
import { currentPlatform, triggerFromEvent } from "./trigger.ts";

/** Returns true when the action ran; false lets the key reach the page. */
export type ActionHandler = (action: string) => boolean;

const handlers: Record<Scope, Set<ActionHandler>> = { app: new Set(), terminal: new Set() };

/** Runs when no handler takes an action, e.g. the desktop app closing its window on close-tab with nothing to close. */
const fallbacks = new Map<string, () => boolean>();

export function setActionFallback(id: string, fallback: () => boolean): void {
  fallbacks.set(id, fallback);
}

function dispatch(scope: Scope, action: string): boolean {
  for (const handler of handlers[scope]) if (handler(action)) return true;
  return fallbacks.get(action)?.() ?? false;
}

let chosen = false;

/**
 * True while an action chosen from a list runs, rather than one a key sent: from the command palette, which closes once
 * runAction returns true and so is still open while the action runs, or from an item in the desktop app's native Shell
 * or View menu, which closes no dialog of the page's. A handler's guard against acting behind a modal does not apply
 * either way.
 */
export const actionChosen = (): boolean => chosen;

/** Runs a bound action as if its key was pressed; false when no handler took it. */
export function runAction(id: string): boolean {
  const action = actionFor(id);
  if (action === null) return false;
  chosen = true;
  try {
    return dispatch(action.scope, id);
  } finally {
    chosen = false;
  }
}

/** True under a view that is kept but not shown (the workspace under Settings): its handlers take no action. */
export const ActionsPaused = createContext(false);

export function useActionHandler(scope: Scope, handler: ActionHandler): void {
  const latest = useRef(handler);
  latest.current = handler;
  const paused = useRef(false);
  paused.current = useContext(ActionsPaused);
  useEffect(() => {
    const entry: ActionHandler = (action) => !paused.current && latest.current(action);
    handlers[scope].add(entry);
    return () => {
      handlers[scope].delete(entry);
    };
  }, [scope]);
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".wterm") !== null;
}

function inFindBar(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-slot="find-bar"]') !== null;
}

const NOT_TEXT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || inTerminal(target)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !NOT_TEXT.has(target.type);
}

/**
 * Actions the browser itself carries out for a terminal, so their key must reach it uncancelled: paste runs as the
 * browser's own paste event (bracketed when the program asked, and through clipboard-paste-protection). The terminal's
 * key handling never sees the key, or it would encode it (ctrl+shift+v as ^V, shift+insert as ^[[2;2~) and cancel the
 * paste (#510).
 */
const BROWSER_RUNS = new Set(["terminal.paste"]);

/** A focused row of a list that can be reordered (`data-reorder-keys`) moves itself with the tab move keys (#140). */
function inReorderableRow(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-reorder-keys]") !== null;
}

export function useKeymapDispatcher(): void {
  const overrides = useOverrides();
  const keymap = useMemo(() => resolveKeymap(currentPlatform(), overrides), [overrides]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const trigger = triggerFromEvent(event);
      if (trigger === null) return;
      const id = keymap.get(trigger);
      if (id === undefined) return;
      const action = actionFor(id);
      if (action === null) return;
      // Find asked for again from its own field selects the query again, as from the terminal.
      if (
        action.scope === "terminal" &&
        !inTerminal(event.target) &&
        !(id === "terminal.search" && inFindBar(event.target))
      )
        return;
      // A focused terminal program keeps its own control keys: the key reaches it uncancelled, as it would from the shell.
      if (TERMINAL_KEEPS.has(id) && inTerminal(event.target)) return;
      // The tab move keys stay with a text field (they select text) and with a reorderable row (they move the row).
      if (TEXT_FIELD_KEEPS.has(id) && (inTextField(event.target) || inReorderableRow(event.target))) return;
      if (dispatch(action.scope, id)) {
        event.preventDefault();
        event.stopPropagation();
      } else if (BROWSER_RUNS.has(id)) event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [keymap]);
}
