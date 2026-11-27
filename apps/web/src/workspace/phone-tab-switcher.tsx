import { Button } from "@doriface/ui";
import { Copy } from "lucide-react";
import { useRef } from "react";
import { liveTabs, type Session, spaceOfAddress } from "./model.ts";
import type { TabsPlace } from "./phone-session-extras.ts";
import { SwitchSheet } from "./phone-switch-sheet.tsx";
import { useSpaceSelection } from "./space-selection.ts";

/** The live tabs of the space whose tabs show `address`, each as its panes; empty when it is in no space's tab. */
export function useSpaceTabs(terminals: readonly Session[], address: string): readonly (readonly string[])[] {
  const { spaces } = useSpaceSelection();
  const space = spaceOfAddress(spaces, address);
  return space === undefined ? [] : liveTabs(space, terminals);
}

/**
 * The open tab's place in its space and the name of the switch that shows it, "Switch tab, <space>, <title>, tab n of
 * m"; null when the terminal is in no space's tab. `title` is the tab's name, else its terminal's title.
 */
export function useTabsPlace(terminals: readonly Session[], address: string, title: string): TabsPlace | null {
  const { spaces } = useSpaceSelection();
  const tabs = useSpaceTabs(terminals, address);
  const at = tabs.findIndex((panes) => panes.includes(address));
  if (at === -1) return null;
  const space = spaceOfAddress(spaces, address)?.name;
  const label = `Switch tab, ${space === undefined ? "" : `${space}, `}${title}, tab ${at + 1} of ${tabs.length}`;
  return { at, count: tabs.length, label };
}

/** The session sheet's "..." button, where the focus goes back when the switch sheet closes without its chip. */
const SESSION_ACTIONS = "[data-titlebar] [data-session-actions]";

/**
 * The phone terminal's tabs control, in its header as the Herdr app keeps its tab count (#2879): the tab's place in its
 * space (`n/m`), and one tap opens the switch sheet of every space and its tabs. It replaces the bottom tabs bar (#466),
 * whose row and home inset cost the terminal about five rows. On a portrait phone (under 430 px) the header keeps the
 * title's room and the mic, so the chip is not drawn and the session sheet's Tabs row opens the same sheet.
 */
export function PhoneTabsChip(props: {
  readonly terminals: readonly Session[];
  readonly place: TabsPlace;
  readonly active: string;
  readonly onOpen: (address: string) => void;
  /** Whether the switch sheet is open, and its opening and closing (the route holds it). */
  readonly sheet: boolean;
  readonly onSheet: (open: boolean) => void;
  readonly onNewInSpace: (key: string) => void;
  /** Closes the tab that shows `address`, as the desktop strip's close does (its questions included) (#1463). */
  readonly onCloseTab: (address: string) => void;
}) {
  const { terminals, place, active, onOpen, sheet, onSheet, onNewInSpace, onCloseTab } = props;
  const chip = useRef<HTMLButtonElement>(null);
  return (
    // `contents`: the chip is one more header item. Not drawn on a portrait phone; its sheet (portalled to the body)
    // stays mounted for the session sheet's Tabs row, and hands the focus back to "..." rather than to a hidden chip.
    <span data-phone-tabs className="contents max-[430px]:hidden">
      <SwitchSheet
        terminals={terminals}
        active={active}
        open={sheet}
        onOpenChange={onSheet}
        onOpen={onOpen}
        onNewInSpace={onNewInSpace}
        onCloseTab={onCloseTab}
        finalFocus={() =>
          chip.current?.checkVisibility() === true ? true : document.querySelector<HTMLElement>(SESSION_ACTIONS)
        }
        trigger={
          <Button
            ref={chip}
            variant="ghost"
            aria-label={place.label}
            className="shrink-0 gap-1 rounded-full bg-muted px-2.5 text-sm text-foreground tabular-nums"
          >
            <Copy aria-hidden className="size-4 text-muted-foreground" />
            <span data-numeric>{`${place.at + 1}/${place.count}`}</span>
          </Button>
        }
      />
    </span>
  );
}
