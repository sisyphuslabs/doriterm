import { IconButton, Menu, MenuItem } from "@doriface/ui";
import { Ellipsis, Pencil, Power } from "lucide-react";
import { useAskSession } from "./session-context.ts";

export interface SessionMenuProps {
  readonly address: string;
  readonly title: string;
}

/**
 * Whether a session menu gives focus back as it goes: not while a modal dialog an item opened is up (Rename…, End's question,
 * or the statement that replaces that question when the session ends). A menu still closing when its session ends
 * decides as the question is swapped for the statement, when neither has focus, and hands it over a moment later: by
 * then behind the statement, on whatever is still on the page (#590, #2362). So it asks whether a dialog is up, not
 * whether one has focus. Only a modal one counts: a toast is a dialog too (#2380). Once the question is dismissed,
 * the menu's exit may still be pending: it must not take focus from a terminal or another control chosen meanwhile
 * (#2521). Only the closing menu counts as "still has focus": a menu that is open (Base UI marks it data-open) was
 * opened meanwhile and keeps its focus (#2547). Supplying finalFocus opts out of Base UI's default check that focus has
 * moved outside the menu.
 */
export function menuReturnsFocus(): boolean {
  if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]') !== null)
    return false;
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  const menu = active.closest('[role="menu"]');
  return menu !== null && !menu.hasAttribute("data-open");
}

/** What can be done with a terminal's session: its "..." menu and a split pane header's right-click hold the same items. */
export function SessionMenuItems({ address }: { readonly address: string }) {
  const ask = useAskSession();
  return (
    <>
      <MenuItem icon={<Pencil />} onClick={() => ask({ kind: "rename", address })}>
        Rename…
      </MenuItem>
      <MenuItem icon={<Power />} destructive onClick={() => ask({ kind: "end", address })}>
        End session…
      </MenuItem>
    </>
  );
}

/** The actions on a terminal's session: rename it, or end its program. */
export function SessionMenu({ address, title }: SessionMenuProps) {
  const label = `Session actions for ${title}`;
  return (
    <Menu
      align="end"
      finalFocus={menuReturnsFocus}
      trigger={<IconButton label={label} icon={<Ellipsis />} className="size-6" />}
    >
      <SessionMenuItems address={address} />
    </Menu>
  );
}
