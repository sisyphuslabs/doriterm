import { Plus } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { IconButton } from "./icon-button.tsx";
import { Menu } from "./menu.tsx";

export interface TabNewButtonProps {
  readonly onNew?: (() => void) | undefined;
  readonly disabled: boolean;
  readonly menu?: ReactNode | undefined;
  readonly keys?: readonly string[] | undefined;
}

/**
 * The strip's New tab button, outside the scrolling tabs so many tabs never push it away (#466 item 5). With `menu`,
 * opens herdr-app's new menu while keeping the page live so a chosen terminal takes the keyboard at once (#1014).
 */
export function TabNewButton({ onNew, disabled, menu, keys }: TabNewButtonProps) {
  // Whether the New tab menu closed on one of its items, rather than Escape or a click away, and what that item gave the
  // keyboard to (a terminal being started takes it at once, type-ahead).
  const chose = useRef(false);
  const handedTo = useRef<HTMLElement | null>(null);
  if (menu === undefined) {
    return (
      <IconButton
        label="New tab"
        {...(keys === undefined ? {} : { keys })}
        icon={<Plus />}
        disabled={disabled}
        onClick={onNew}
      />
    );
  }
  return (
    <Menu
      trigger={
        <IconButton label="New tab" {...(keys === undefined ? {} : { keys })} icon={<Plus />} disabled={disabled} />
      }
      className="w-[250px]"
      disabled={disabled}
      onOpenChange={(open) => {
        if (!open) return;
        chose.current = false;
        handedTo.current = null;
      }}
      // A choice starts a tab that takes the keyboard at once, so the page stays live (not modal) and, as the menu
      // closes, focus goes where the choice put it rather than back to +, where the next keys typed would press it.
      modal={false}
      // Base UI asks once the closing animation has ended. The page was live all along, so by then the person may
      // have moved on (another menu, a dialog): what holds the keyboard now keeps it (#1014).
      finalFocus={() => {
        const holder = document.activeElement;
        const movedOn = holder instanceof HTMLElement && holder !== document.body && holder !== handedTo.current;
        if (movedOn) return false;
        return chose.current ? (handedTo.current ?? false) : true;
      }}
    >
      <div
        className="contents"
        onClickCapture={(event) => {
          chose.current = true;
          const popup = event.currentTarget;
          const record = (focus: FocusEvent): void => {
            if (focus.target instanceof HTMLElement && !popup.contains(focus.target)) handedTo.current = focus.target;
          };
          document.addEventListener("focusin", record, true);
          // Removed once the whole click has been dispatched (microtasks would run between its listeners, before the
          // item's own handler focuses anything).
          setTimeout(() => document.removeEventListener("focusin", record, true), 0);
        }}
      >
        {menu}
      </div>
    </Menu>
  );
}
