import { Button } from "@doriface/ui";
import { Copy } from "lucide-react";
import { liveTabs, type Session, spaceOfAddress } from "./model.ts";
import { SwitchSheet } from "./phone-switch-sheet.tsx";
import { useSpaceSelection } from "./space-selection.ts";

/** The live tabs of the space whose tabs show `address`, each as its panes; empty when it is in no space's tab. */
export function useSpaceTabs(terminals: readonly Session[], address: string): readonly (readonly string[])[] {
  const { spaces } = useSpaceSelection();
  const space = spaceOfAddress(spaces, address);
  return space === undefined ? [] : liveTabs(space, terminals);
}

/**
 * The phone terminal's tabs control, in its header as the Herdr app keeps its tab count (#2879): the tab's place in its
 * space (`n/m`), and one tap opens the switch sheet of every space and its tabs. It replaces the bottom tabs bar (#466),
 * whose row and home inset cost the terminal about five rows. Nothing when the terminal is in no space's tab.
 */
export function PhoneTabsChip(props: {
  readonly terminals: readonly Session[];
  readonly active: string;
  /** The open tab's name, else its terminal's title. */
  readonly title: string;
  readonly onOpen: (address: string) => void;
  /** Whether the switch sheet is open, and its opening and closing (the route holds it). */
  readonly sheet: boolean;
  readonly onSheet: (open: boolean) => void;
  readonly onNewInSpace: (key: string) => void;
  /** Closes the tab that shows `address`, as the desktop strip's close does (its questions included) (#1463). */
  readonly onCloseTab: (address: string) => void;
}) {
  const { terminals, active, title, onOpen, sheet, onSheet, onNewInSpace, onCloseTab } = props;
  const { spaces } = useSpaceSelection();
  const space = spaceOfAddress(spaces, active)?.name;
  const tabs = useSpaceTabs(terminals, active);
  const at = tabs.findIndex((panes) => panes.includes(active));
  if (at === -1) return null;
  return (
    // `contents`: the chip is one more header item; the wrapper only names the control for its tests.
    <span data-phone-tabs className="contents">
      <SwitchSheet
        terminals={terminals}
        active={active}
        open={sheet}
        onOpenChange={onSheet}
        onOpen={onOpen}
        onNewInSpace={onNewInSpace}
        onCloseTab={onCloseTab}
        trigger={
          <Button
            variant="ghost"
            aria-label={`Switch tab, ${space === undefined ? "" : `${space}, `}${title}, tab ${at + 1} of ${tabs.length}`}
            className="shrink-0 gap-1 rounded-full bg-muted px-2.5 text-sm text-foreground tabular-nums"
          >
            <Copy aria-hidden className="size-4 text-muted-foreground" />
            <span data-numeric>{`${at + 1}/${tabs.length}`}</span>
          </Button>
        }
      />
    </span>
  );
}
